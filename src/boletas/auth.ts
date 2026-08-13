// Cliente de autenticación de boletas electrónicas (eboleta.sii.cl).
//
// A diferencia del portal CGI (certificado + cookie jar), boletas es una app AWS
// y la autenticación es RUT + clave tributaria por OAuth. Relevado en vivo el
// 2026-08-12 (ver docs/superpowers/specs/2026-08-12-boletas-eboleta-spike.md):
// tres pasos que terminan en credenciales AWS temporales para firmar SigV4.
//
//   1. login       POST authorize (clave.w.sii.cl)      user+password → code
//   2. signIn      POST /prod/sign-in (apiAuthSII)       code+state    → token OpenID
//   3. credenciales POST GetCredentialsForIdentity       token         → AccessKey/Secret/SessionToken
//
// El transporte se inyecta: en producción es fetch nativo (Node 24); en tests,
// un doble. No usa el SiiHttpClient del CGI —eso va con cookie jar y curl, acá
// es JSON plano a hosts de AWS con TLS estándar.

const AUTHORIZE_URL = 'https://clave.w.sii.cl/oauthsii-v1-ms/authorization/v1/authorize';
// apiAuthSII. El endpoint es público (Amplify lo firma con credenciales
// indefinidas): valida el code contra el SII y devuelve un token OpenID de
// Cognito emitido del lado servidor (GetOpenIdTokenForDeveloperIdentity).
const SIGN_IN_URL = 'https://x78kr8nqx5.execute-api.us-east-1.amazonaws.com/prod/sign-in';
const COGNITO_IDENTITY_URL = 'https://cognito-identity.us-east-1.amazonaws.com/';
// El token OpenID viaja bajo esta clave en Logins: es el nombre del proveedor de
// identidad de Cognito (developer authenticated identities).
const PROVEEDOR_OPENID = 'cognito-identity.amazonaws.com';

// Client id público del OAuth del SII para eboleta (no es secreto: viaja en la
// URL de login de cualquier navegador).
const CLIENT_ID = 'e0378e96-4014-4a47-b852-9d9246797f5c';
const REDIRECT_URI = 'https://eboleta.sii.cl/emitir/';
const SCOPE = 'user_info';

export interface PeticionHttp {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface RespuestaHttp {
  status: number;
  body: string;
}

export type HttpBoletas = (peticion: PeticionHttp) => Promise<RespuestaHttp>;

// Credenciales AWS temporales (STS) con las que se firman SigV4 las llamadas a
// la API de boletas. `expiration` es epoch en segundos.
export interface CredencialesAws {
  accessKeyId: string;
  secretKey: string;
  sessionToken: string;
  expiration: number;
}

// El login pide verificar identidad por correo (dispositivo nuevo / 2FA). Un
// gateway headless no puede resolverlo solo: se distingue con tipo propio para
// que el llamador lo trate distinto de una clave incorrecta.
export class RequiereChallenge extends Error {}

// Resumen de una respuesta para meter en un mensaje de error SIN filtrar
// secretos. Los mensajes van a logs, y una respuesta parcial del SII o de
// Cognito puede traer el token OpenID, la SecretKey o el SessionToken: se
// redactan por nombre antes de serializar. Se conserva el resto (códigos,
// mensajes) que es lo que sirve para diagnosticar.
const CLAVES_SENSIBLES = /^(token|secretkey|sessiontoken|accesskeyid|password|clave)$/i;

function resumenSeguro(valor: unknown): string {
  const redactado = JSON.stringify(valor, (clave, v) =>
    CLAVES_SENSIBLES.test(clave) ? '[REDACTADO]' : v
  );
  return (redactado ?? String(valor)).slice(0, 150);
}

export class BoletaAuth {
  constructor(private http: HttpBoletas) {}

  // `state` lo genera el llamador (un uuid) y viaja de vuelta en el redirect:
  // sirve para atar la respuesta a esta petición. `tokenCaptcha` es "0" cuando
  // el SII no exige captcha, que es lo observado; se deja parametrizable porque
  // puede exigirlo en otras condiciones (ver pendiente del spec).
  async login(
    user: string,
    password: string,
    state: string,
    tokenCaptcha = '0'
  ): Promise<{ code: string; state: string }> {
    const respuesta = await this.postJson(AUTHORIZE_URL, {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state,
      user,
      password,
      token_captcha: tokenCaptcha,
      action_captcha: 'login',
    });

    // El SPA de login trata el error por `code` (612 clave incorrecta, 611 debe
    // obtener clave). Se propaga con el mensaje del SII cuando lo hay.
    if (respuesta.success === false || (respuesta.code && !respuesta.action)) {
      throw new Error(
        `El SII rechazó el login (código ${respuesta.code ?? 'desconocido'}): ` +
        `${respuesta.message ?? 'clave tributaria incorrecta o cuenta sin clave'}.`
      );
    }

    if (respuesta.action === 'CHLNG') {
      throw new RequiereChallenge(
        'El SII exige verificar la identidad por correo (challenge de dispositivo nuevo). ' +
        'No se puede completar el login de forma automática hasta resolverlo.'
      );
    }

    // En éxito, el servidor arma el redirect_uri COMPLETO con el code adentro;
    // el SPA sólo hace window.location = redirect_uri. Se extrae el code de ahí.
    const code = this.codeDeRedirect(respuesta.redirect_uri);
    if (!code) {
      throw new Error(
        'El login fue aceptado pero no se encontró el code en la respuesta del SII. ' +
        'La forma de la respuesta pudo cambiar.'
      );
    }
    return { code, state };
  }

  // Paso 2: el code de OAuth por un token OpenID de Cognito. El endpoint es
  // público, así que no necesita credenciales AWS previas —es el que las
  // arranca—.
  async signIn(code: string, state: string): Promise<{ identityId: string; token: string }> {
    const respuesta = await this.postJson(SIGN_IN_URL, {
      rut: '',
      opts: { code, state, authMethod: 'clave-tributaria' },
    });

    const openId = respuesta.openId;
    if (!openId?.Token || !openId?.IdentityId) {
      throw new Error(
        'El sign-in del SII no devolvió el token de Cognito. El code pudo vencer o ser ' +
        `inválido. Respuesta: ${resumenSeguro(respuesta)}.`
      );
    }
    return { identityId: openId.IdentityId, token: openId.Token };
  }

  // Paso 3: el token OpenID por credenciales AWS temporales (STS). Con estas se
  // firman SigV4 las llamadas a la API de boletas. Caducan (ver `expiration`):
  // renovar repitiendo este paso con el mismo token mientras el token viva.
  async getCredentials(
    identityId: string,
    token: string
  ): Promise<CredencialesAws> {
    const respuesta = await this.postJson(
      COGNITO_IDENTITY_URL,
      { IdentityId: identityId, Logins: { [PROVEEDOR_OPENID]: token } },
      {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
      }
    );

    const c = respuesta.Credentials;
    if (!c?.AccessKeyId || !c?.SecretKey || !c?.SessionToken) {
      throw new Error(
        'Cognito no devolvió credenciales temporales. El token pudo vencer o el identity ' +
        `pool rechazó el login. Respuesta: ${resumenSeguro(respuesta)}.`
      );
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretKey: c.SecretKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration,
    };
  }

  // Los tres pasos de punta a punta: RUT + clave tributaria → credenciales AWS
  // temporales. `nuevoState` produce un identificador único por intento (un uuid
  // en producción); se inyecta para que los tests sean deterministas.
  async autenticar(
    user: string,
    password: string,
    nuevoState: () => string
  ): Promise<CredencialesAws> {
    const { code, state } = await this.login(user, password, nuevoState());
    const { identityId, token } = await this.signIn(code, state);
    return this.getCredentials(identityId, token);
  }

  private codeDeRedirect(redirectUri: unknown): string | null {
    if (typeof redirectUri !== 'string' || redirectUri.length === 0) return null;
    const m = /[?&]code=([^&]+)/.exec(redirectUri);
    return m ? decodeURIComponent(m[1]) : null;
  }

  private async postJson(
    url: string,
    cuerpo: unknown,
    headers: Record<string, string> = { 'Content-Type': 'application/json' }
  ): Promise<any> {
    const respuesta = await this.http({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(cuerpo),
    });
    try {
      return JSON.parse(respuesta.body);
    } catch {
      throw new Error(
        `Respuesta no-JSON de ${url} (status ${respuesta.status}): ${respuesta.body.slice(0, 120)}`
      );
    }
  }
}
