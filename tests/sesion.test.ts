import { SessionManager } from '../src/session';
import { AuthStrategy, SiiConfig } from '../src/env';
import { Browser } from '../src/browser';

jest.mock('../src/browser');

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

const config = {
  strategy: AuthStrategy.Clave,
  rut: '11111111-1',
  clave: 'secreta',
} as SiiConfig;

const loginSnapshot = [
  '- textbox "Rut" [ref=e1]',
  '- textbox "Clave" [ref=e2]',
  '- button "Ingresar" [ref=e3]',
].join('\n');

// Snapshot posterior a un login exitoso: sin campo de clave. fillClaveForm
// verifica esto tras el click (ver src/session.ts) — con loginSnapshot
// forever, ninguna autenticación de este archivo terminaría nunca.
const snapshotPostLogin = '- generic\n  - StaticText "Portal"';

function makeSession() {
  const browser = new MockBrowser();
  (browser.snapshot as jest.Mock)
    .mockReturnValueOnce(loginSnapshot)
    .mockReturnValue(snapshotPostLogin);
  // Además del campo de clave, fillClaveForm confirma que el destino final
  // sea un dominio de sii.cl (ver comentario en src/session.ts).
  (browser.eval as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
  return { browser, session: new SessionManager(config, browser) };
}

// El SII limita las sesiones simultáneas por RUT y las bloquea al superarlas
// (error 01.01.190.500.720.27), así que reautenticar por consulta las agota.
describe('SessionManager: reuso de sesión', () => {
  it('autentica una sola vez aunque se pidan varias consultas', async () => {
    const { browser, session } = makeSession();

    await session.authenticateOnly();
    await session.authenticateOnly();
    await session.authenticateOnly();

    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave/.test(url));
    expect(loginOpens).toHaveLength(1);
  });

  it('vuelve a autenticar después de invalidate()', async () => {
    const { browser, session } = makeSession();

    await session.authenticateOnly();
    session.invalidate();
    await session.authenticateOnly();

    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave/.test(url));
    expect(loginOpens).toHaveLength(2);
  });
});

// El CGI de autenticación escribe `locexp` por JavaScript en vez de mandarla en
// un Set-Cookie, así que curl no la captura. Sin ella el portal rechaza la
// sesión aunque el resto de las cookies sea válido, y sin mensaje de error.
describe('SessionManager.listEmpresasDisponibles', () => {
  it('espera a que rinda la página antes de leer el combo de empresas', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock).mockReturnValue(
      '- option "EMPRESA UNO SPA 11111111-1" [ref=e11]'
    );
    (browser.eval as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    const session = new SessionManager(config, browser);

    await session.listEmpresasDisponibles();

    // Sin la espera, un snapshot prematuro devuelve cero empresas.
    expect(browser.waitForAny).toHaveBeenCalled();
    const [markers] = (browser.waitForAny as jest.Mock).mock.calls[0];
    expect(markers).toContain('SELECCIÓN DE EMPRESA');
  });
});

describe('SessionManager: página de empresas que no rinde', () => {
  it('falla explícitamente en vez de reportar cero empresas', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock).mockReturnValue('- generic\n  - StaticText "Cargando"');
    (browser.eval as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    const session = new SessionManager(config, browser);

    await expect(session.listEmpresasDisponibles()).rejects.toThrow(/no terminó de cargar/);
  });
});

describe('SessionManager: cookie locexp', () => {
  const certConfig = {
    strategy: AuthStrategy.Certificate,
    rut: '11111111-1',
    certPath: '/tmp/cert.pfx',
    certPassword: 'x',
  } as SiiConfig;

  it('inyecta NETSCAPE_LIVEWIRE.locexp al autenticar con certificado', async () => {
    const browser = new MockBrowser();
    const session = new SessionManager(certConfig, browser);
    // Evitar openssl/curl reales: solo interesa la inyección de cookies.
    (session as any).loginWithCert = async () => {
      (session as any).setLocExpCookie();
    };

    await session.authenticateOnly();

    const evals = (browser.eval as jest.Mock).mock.calls.map(([js]) => js);
    expect(evals.some(js => js.includes('NETSCAPE_LIVEWIRE.locexp'))).toBe(true);
  });

  it('le da a locexp una expiración futura', async () => {
    const browser = new MockBrowser();
    const session = new SessionManager(certConfig, browser);

    (session as any).setLocExpCookie();

    const [js] = (browser.eval as jest.Mock).mock.calls[0];
    const fecha = js.match(/locexp=([^;]+);/)![1];
    expect(new Date(fecha).getTime()).toBeGreaterThan(Date.now());
  });
});

// El CGI responde 200 aunque rechace: el error viaja dentro de un alert() de JS.
describe('SessionManager: detección de rechazo del CGI', () => {
  const session = new SessionManager({} as any, new MockBrowser());
  const assert = (html: string) => (session as any).assertAutenticacionExitosa(html);

  it('reporta el mensaje del SII cuando supera el máximo de sesiones', () => {
    const html = `<script>alert('Usted ha superado el máximo de sesiones autenticadas');</script>`;
    expect(() => assert(html)).toThrow(/máximo de sesiones autenticadas/);
  });

  it('falla si no hubo redirección al portal', () => {
    expect(() => assert('<html><body>algo inesperado</body></html>')).toThrow(/no completó la autenticación/);
  });

  it('acepta la respuesta de éxito', () => {
    const html = `<script>location.replace('https://mipyme.sii.cl/');</script>`;
    expect(() => assert(html)).not.toThrow();
  });
});

// Diagnóstico del falso negativo con clave válida (ver src/session.ts):
// estos dos saneadores garantizan que el log nunca lleve PII, sin importar
// qué texto traiga el snapshot o la URL real.
describe('SessionManager: saneadores de logging (sin PII)', () => {
  const session = new SessionManager({} as any, new MockBrowser());
  const resumen = (s: string) => (session as any).resumenEstructuralParaLog(s);
  const url = (u: string) => (session as any).sanearUrlParaLog(u);

  it('extrae sólo rol y ref, nunca el texto entre comillas', () => {
    const snapshot = [
      '- textbox "Ingrese su Clave" [ref=e2]',
      '- button "Ingresar" [ref=e3]',
    ].join('\n');
    const salida = resumen(snapshot);
    expect(salida).toBe('textbox[e2],button[e3]');
    expect(salida).not.toContain('Clave');
    expect(salida).not.toContain('Ingresar');
  });

  // El propio CLI trae texto plano SIN comillas fuera de los elementos (el
  // encabezado con título/URL de la página) — un saneador que sólo mira
  // comillas lo dejaría pasar intacto. Con allowlist por rol, ese texto
  // libre no matchea ningún rol conocido y queda afuera.
  it('descarta texto libre sin rol reconocible (encabezado título/URL del CLI)', () => {
    const snapshot = [
      '✓ Bienvenido JUAN PEREZ - Portal MiSII',
      '  https://misii.sii.cl/portal?rut=11111111-1',
      '- heading "Selección de empresa" [ref=e1]',
    ].join('\n');
    // Igualdad exacta, no `not.toContain`: un assert negativo deja pasar
    // fugas parciales (por ejemplo si el regex matcheara "Portal" o "Soto"
    // de un apellido compuesto, `not.toContain('JUAN PEREZ')` seguiría en
    // verde). Sólo `heading[e1]` debe sobrevivir.
    expect(resumen(snapshot)).toBe('heading[e1]');
  });

  // El caso concreto que un regex sin anclar ni validar contra roles
  // conocidos deja pasar: una línea de texto libre que empieza con "- " (el
  // mismo marcador que usan los elementos reales) pero cuya primera palabra
  // NO es un rol — acá "Bienvenido" no está en ROLES_CONOCIDOS, así que la
  // línea entera queda afuera, sin importar qué apellido compuesto con
  // guion venga después.
  it('línea con "- " que no es un elemento real (primera palabra no es rol conocido) no se cuela', () => {
    const snapshot = [
      '- Bienvenido MARIA PEREZ-SOTO',
      '- button "Ingresar" [ref=e3]',
    ].join('\n');
    expect(resumen(snapshot)).toBe('button[e3]');
  });

  it('snapshot vacío no rompe, devuelve marcador explícito', () => {
    expect(resumen('')).toBe('(vacío)');
  });

  it('quita el query string de la URL (puede traer RUT o token)', () => {
    expect(url('https://misii.sii.cl/portal/inicio?rut=11111111-1&token=abc123'))
      .toBe('https://misii.sii.cl/portal/inicio');
  });

  it('URL no parseable no rompe, devuelve marcador explícito', () => {
    expect(url('esto no es una url')).toBe('(url no parseable)');
  });
});

describe('SessionManager.logout', () => {
  it('navega a la URL de término de sesión del SII', async () => {
    const { browser, session } = makeSession();
    await session.authenticateOnly();

    await session.logout();

    expect(browser.open).toHaveBeenCalledWith('https://zeusr.sii.cl/cgi_AUT2000/autTermino.cgi');
  });

  it('no hace nada si no hay sesión abierta', async () => {
    const { browser, session } = makeSession();

    await session.logout();

    expect(browser.open).not.toHaveBeenCalled();
  });

  it('obliga a reautenticar en la siguiente consulta', async () => {
    const { browser, session } = makeSession();

    await session.authenticateOnly();
    await session.logout();
    await session.authenticateOnly();

    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave/.test(url));
    expect(loginOpens).toHaveLength(2);
  });

  it('marca la sesión como cerrada aunque falle la navegación', async () => {
    const { browser, session } = makeSession();
    await session.authenticateOnly();
    (browser.open as jest.Mock).mockImplementationOnce(() => { throw new Error('red caída'); });

    await expect(session.logout()).rejects.toThrow('red caída');

    // Un logout fallido no debe dejar la sesión marcada como viva.
    await session.authenticateOnly();
    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave/.test(url));
    expect(loginOpens).toHaveLength(2);
  });
});
