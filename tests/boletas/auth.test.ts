import { BoletaAuth, HttpBoletas } from '../../src/boletas/auth';

// Transporte falso: guarda las llamadas y devuelve respuestas encoladas por
// URL. Así los tests fijan qué se postea y qué se recibe, sin red.
function transporteFalso(respuestas: Record<string, { status?: number; body: string }>) {
  const llamadas: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const http: HttpBoletas = async req => {
    llamadas.push(req);
    const match = Object.keys(respuestas).find(u => req.url.includes(u));
    if (!match) throw new Error(`sin respuesta encolada para ${req.url}`);
    const r = respuestas[match];
    return { status: r.status ?? 200, body: r.body };
  };
  return { http, llamadas };
}

describe('BoletaAuth.login', () => {
  it('postea RUT y clave al authorize y saca el code del redirect_uri', async () => {
    const { http, llamadas } = transporteFalso({
      '/authorization/v1/authorize': {
        body: JSON.stringify({
          action: 'REDIRECT',
          redirect_uri: 'https://eboleta.sii.cl/emitir/?code=abc-123&state=st-1',
        }),
      },
    });
    const auth = new BoletaAuth(http);

    const { code, state } = await auth.login('17270613', 'clave-secreta', 'st-1');

    // El code sale del redirect_uri que arma el servidor, no de un campo suelto.
    expect(code).toBe('abc-123');
    expect(state).toBe('st-1');

    // El cuerpo posteado lleva user, password y los campos fijos del OAuth.
    const body = JSON.parse(llamadas[0].body);
    expect(body).toMatchObject({
      response_type: 'code',
      scope: 'user_info',
      action_captcha: 'login',
      user: '17270613',
      password: 'clave-secreta',
      state: 'st-1',
    });
    expect(body.client_id).toBeTruthy();
    expect(llamadas[0].headers['Content-Type']).toBe('application/json');
  });

  it('falla con mensaje claro cuando la clave es incorrecta (código 612)', async () => {
    const { http } = transporteFalso({
      '/authorization/v1/authorize': {
        body: JSON.stringify({ success: false, code: 612, message: 'password incorrecto' }),
      },
    });
    const auth = new BoletaAuth(http);

    await expect(auth.login('17270613', 'mala', 'st-1')).rejects.toThrow(/612|password|clave/i);
  });

  it('avisa cuando el SII exige un challenge por email (dispositivo nuevo)', async () => {
    // Rama CHLNG del SPA: el login pide verificar identidad por correo. Un
    // gateway headless no puede resolverlo solo, así que hay que reportarlo
    // como tal en vez de fallar con un error genérico de parseo.
    const { http } = transporteFalso({
      '/authorization/v1/authorize': {
        body: JSON.stringify({ action: 'CHLNG', challenge_code: 'xyz', redirect_uri: '' }),
      },
    });
    const auth = new BoletaAuth(http);

    await expect(auth.login('17270613', 'clave', 'st-1')).rejects.toThrow(/challenge|verificar|correo|email/i);
  });
});

describe('BoletaAuth.signIn', () => {
  it('intercambia el code por el token OpenID de Cognito', async () => {
    const { http, llamadas } = transporteFalso({
      '/prod/sign-in': {
        body: JSON.stringify({
          openId: { IdentityId: 'us-east-1:aaa', Token: 'jwt-token' },
        }),
      },
    });
    const auth = new BoletaAuth(http);

    const r = await auth.signIn('abc-123', 'st-1');

    expect(r).toEqual({ identityId: 'us-east-1:aaa', token: 'jwt-token' });
    const body = JSON.parse(llamadas[0].body);
    // El contrato observado: rut vacío, y el code/state dentro de opts con
    // authMethod fijo.
    expect(body).toEqual({
      rut: '',
      opts: { code: 'abc-123', state: 'st-1', authMethod: 'clave-tributaria' },
    });
  });

  it('falla si el SII no devuelve el token', async () => {
    const { http } = transporteFalso({
      '/prod/sign-in': { body: JSON.stringify({ error: 'code inválido o vencido' }) },
    });
    const auth = new BoletaAuth(http);

    await expect(auth.signIn('viejo', 'st-1')).rejects.toThrow(/token|sign-in|rechaz/i);
  });
});

describe('BoletaAuth.getCredentials', () => {
  it('canjea el token por credenciales AWS temporales en el identity pool correcto', async () => {
    const { http, llamadas } = transporteFalso({
      'cognito-identity.us-east-1.amazonaws.com': {
        body: JSON.stringify({
          IdentityId: 'us-east-1:aaa',
          Credentials: {
            AccessKeyId: 'ASIAXXX',
            SecretKey: 'secret',
            SessionToken: 'session',
            Expiration: 1786561794,
          },
        }),
      },
    });
    const auth = new BoletaAuth(http);

    const cred = await auth.getCredentials('us-east-1:aaa', 'jwt-token');

    expect(cred).toEqual({
      accessKeyId: 'ASIAXXX',
      secretKey: 'secret',
      sessionToken: 'session',
      expiration: 1786561794,
    });

    // Los headers de la API de Cognito son obligatorios: sin el x-amz-target el
    // servicio no sabe qué operación es.
    expect(llamadas[0].headers['Content-Type']).toBe('application/x-amz-json-1.1');
    expect(llamadas[0].headers['X-Amz-Target']).toBe('AWSCognitoIdentityService.GetCredentialsForIdentity');
    const body = JSON.parse(llamadas[0].body);
    // El token va bajo la clave del proveedor OpenID de Cognito.
    expect(body.Logins['cognito-identity.amazonaws.com']).toBe('jwt-token');
    expect(body.IdentityId).toBe('us-east-1:aaa');
  });
});

describe('BoletaAuth.autenticar (orquesta los 3 pasos)', () => {
  it('encadena login → signIn → credenciales y devuelve las credenciales AWS', async () => {
    const { http } = transporteFalso({
      '/authorization/v1/authorize': {
        body: JSON.stringify({
          action: 'REDIRECT',
          redirect_uri: 'https://eboleta.sii.cl/emitir/?code=c1&state=st',
        }),
      },
      '/prod/sign-in': {
        body: JSON.stringify({ openId: { IdentityId: 'us-east-1:id', Token: 'tok' } }),
      },
      'cognito-identity.us-east-1.amazonaws.com': {
        body: JSON.stringify({
          Credentials: { AccessKeyId: 'ASIA1', SecretKey: 's', SessionToken: 'st-tok', Expiration: 111 },
        }),
      },
    });
    const auth = new BoletaAuth(http);

    const cred = await auth.autenticar('17270613', 'clave', () => 'st');

    expect(cred.accessKeyId).toBe('ASIA1');
    expect(cred.sessionToken).toBe('st-tok');
  });
});
