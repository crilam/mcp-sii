import { SessionManager } from '../src/session';
import { AuthStrategy, SiiConfig } from '../src/env';
import { Browser } from '../src/browser';

jest.mock('../src/browser');

// esperarFormularioDeLogin duerme con execSync('sleep ...'); no aplica acá
// (el form aparece siempre en el primer chequeo), pero se neutraliza igual
// para no depender de que ningún test futuro dispare el loop con tiempo real.
jest.mock('child_process', () => ({
  execSync: jest.fn(() => ''),
  execFileSync: jest.fn(() => ''),
}));

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

// El polling de credenciales (assertLoginPorClaveExitoso) usa setTimeout real.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function conTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promesa = fn();
  promesa.catch(() => {});
  await jest.runAllTimersAsync();
  return promesa;
}

const config = {
  strategy: AuthStrategy.Clave,
  rut: '11111111-1',
  clave: 'secreta',
} as SiiConfig;

// El login por clave llena y envía el form por `eval`, no por fill/click, y
// confirma el éxito mirando la URL final (ver src/session.ts). El mock de
// `eval` inspecciona el JS recibido: responde 'SI' sólo a la pregunta por
// `myform`, para que el resto de los usos (llenado, requestSubmit) no se
// confundan con esa respuesta.
function mockearFormularioPresente(browser: Browser): void {
  (browser.eval as jest.Mock).mockImplementation((js: string) => {
    if (js.includes("getElementById('myform')")) return 'SI';
    return '';
  });
}

function makeSession() {
  const browser = new MockBrowser();
  mockearFormularioPresente(browser);
  (browser.snapshot as jest.Mock).mockReturnValue('- generic\n  - StaticText "Portal"');
  // Confirma que el destino final sea un dominio de sii.cl (ver src/session.ts).
  (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
  return { browser, session: new SessionManager(config, browser) };
}

// El SII limita las sesiones simultáneas por RUT y las bloquea al superarlas
// (error 01.01.190.500.720.27), así que reautenticar por consulta las agota.
describe('SessionManager: reuso de sesión', () => {
  it('autentica una sola vez aunque se pidan varias consultas', async () => {
    const { browser, session } = makeSession();

    await conTimers(() => session.authenticateOnly());
    await conTimers(() => session.authenticateOnly());
    await conTimers(() => session.authenticateOnly());

    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /siihome/.test(url));
    expect(loginOpens).toHaveLength(1);
  });

  it('vuelve a autenticar después de invalidate()', async () => {
    const { browser, session } = makeSession();

    await conTimers(() => session.authenticateOnly());
    session.invalidate();
    await conTimers(() => session.authenticateOnly());

    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /siihome/.test(url));
    expect(loginOpens).toHaveLength(2);
  });
});

// El CGI de autenticación escribe `locexp` por JavaScript en vez de mandarla en
// un Set-Cookie, así que curl no la captura. Sin ella el portal rechaza la
// sesión aunque el resto de las cookies sea válido, y sin mensaje de error.
describe('SessionManager.listEmpresasDisponibles', () => {
  it('espera a que rinda la página antes de leer el combo de empresas', async () => {
    const browser = new MockBrowser();
    mockearFormularioPresente(browser);
    (browser.snapshot as jest.Mock).mockReturnValue(
      '- option "EMPRESA UNO SPA 11111111-1" [ref=e11]'
    );
    (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    const session = new SessionManager(config, browser);

    await conTimers(() => session.listEmpresasDisponibles());

    // Sin la espera, un snapshot prematuro devuelve cero empresas.
    expect(browser.waitForAny).toHaveBeenCalled();
    const [markers] = (browser.waitForAny as jest.Mock).mock.calls[0];
    expect(markers).toContain('SELECCIÓN DE EMPRESA');
  });
});

describe('SessionManager: página de empresas que no rinde', () => {
  it('falla explícitamente en vez de reportar cero empresas', async () => {
    const browser = new MockBrowser();
    mockearFormularioPresente(browser);
    (browser.snapshot as jest.Mock).mockReturnValue('- generic\n  - StaticText "Cargando"');
    (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    const session = new SessionManager(config, browser);

    await expect(conTimers(() => session.listEmpresasDisponibles())).rejects.toThrow(/no terminó de cargar/);
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

// sanearUrlParaLog sigue existiendo: assertLoginPorClaveExitoso lo usa para
// loguear la URL final sin filtrar RUT/token en el query string.
describe('SessionManager: saneadores de logging (sin PII)', () => {
  const session = new SessionManager({} as any, new MockBrowser());
  const url = (u: string) => (session as any).sanearUrlParaLog(u);

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
    await conTimers(() => session.authenticateOnly());

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

    await conTimers(() => session.authenticateOnly());
    await session.logout();
    await conTimers(() => session.authenticateOnly());

    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /siihome/.test(url));
    expect(loginOpens).toHaveLength(2);
  });

  it('marca la sesión como cerrada aunque falle la navegación', async () => {
    const { browser, session } = makeSession();
    await conTimers(() => session.authenticateOnly());
    (browser.open as jest.Mock).mockImplementationOnce(() => { throw new Error('red caída'); });

    await expect(session.logout()).rejects.toThrow('red caída');

    // Un logout fallido no debe dejar la sesión marcada como viva.
    await conTimers(() => session.authenticateOnly());
    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /siihome/.test(url));
    expect(loginOpens).toHaveLength(2);
  });
});
