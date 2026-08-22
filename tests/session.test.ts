import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

// El polling de credenciales (assertLoginPorClaveExitoso) usa setTimeout real
// — con fake timers global + runAllTimersAsync, cualquier test que lo dispare
// (éxito con URLs sucesivas, o rechazo agotando 15s) avanza sin pagar tiempo
// real. El polling del formulario (esperarFormularioDeLogin) usa execSync
// (sincrónico, NO timers): se neutraliza mockeando child_process más abajo.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// esperarFormularioDeLogin duerme con execSync('sleep ...') entre cada poll.
// Sin mockearlo, el test de "el formulario nunca aparece" pagaría 20s reales.
jest.mock('child_process', () => ({
  execSync: jest.fn(() => ''),
  execFileSync: jest.fn(() => ''),
}));

async function conTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promesa = fn();
  // Si `promesa` rechaza mientras runAllTimersAsync todavía está resolviendo
  // timers pendientes, todavía no hay ningún handler adjunto a ella (recién
  // se adjunta al hacer `return promesa` más abajo) — Node lo marca como
  // rejection no manejada, aunque termine manejándose un instante después.
  // Este catch mudo la marca como manejada de inmediato sin alterar el
  // resultado real que ve quien llama a conTimers().
  promesa.catch(() => {});
  await jest.runAllTimersAsync();
  return promesa;
}

function crearBrowserMock(): Browser {
  return new MockBrowser();
}

const configClave: SiiConfig = {
  rut: '12345678',
  strategy: AuthStrategy.Clave,
  clave: 'mipass',
};

// Snapshot del portal mipyme con una sola empresa (formato "NOMBRE RUT-DV")
const empresaUnicaSnapshot = [
  '- combobox [expanded=false, ref=e10]: Empresa',
  '- option "EMPRESA UNO SPA 11111111-1" [ref=e11]',
].join('\n');

// Snapshot con dos empresas
const dosEmpresasSnapshot = [
  '- combobox [expanded=false, ref=e10]: Empresa',
  '- option "EMPRESA UNO SPA 11111111-1" [ref=e11]',
  '- option "EMPRESA DOS LTDA 22222222-2" [ref=e12]',
].join('\n');

// El nuevo login llena y envía el form por `eval`, no por fill/click. El
// mismo método `eval` sirve para tres cosas distintas (chequear si apareció
// myform, llenar los campos, hacer requestSubmit), así que el mock inspecciona
// el JS recibido en vez de devolver un valor fijo — igual que hace el propio
// SessionManager con la respuesta real del navegador.
function mockearEvalFormulario(browser: Browser, formularioAparece = true): void {
  (browser.eval as jest.Mock).mockImplementation((js: string) => {
    if (js.includes("getElementById('myform')") && js.includes('SI')) {
      return formularioAparece ? 'SI' : 'NO';
    }
    return '';
  });
}

// Login por clave exitoso: el formulario aparece y la URL final queda fuera
// del login, en un dominio sii.cl.
function mockearLoginExitoso(
  browser: Browser,
  snapshotEmpresa: string,
  urlFinal = 'https://mipyme.sii.cl/'
): void {
  mockearEvalFormulario(browser, true);
  (browser.getUrl as jest.Mock).mockReturnValue(urlFinal);
  (browser.snapshot as jest.Mock).mockReturnValue(snapshotEmpresa);
}

describe('SessionManager.login', () => {
  it('navega a la puerta de entrada del portal privado, no al form directo', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    // El form de login no rinde si se navega a él directo (about:blank): hay
    // que llegar por redirect desde una página privada del portal.
    expect(browser.open).toHaveBeenCalledWith('https://misiir.sii.cl/cgi_misii/siihome.cgi');
  });

  it('llena el form por JS y lo envía con requestSubmit, no con un click', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    const evals = (browser.eval as jest.Mock).mock.calls.map(([js]) => js as string);
    // Los campos hidden (rut sin DV, dv aparte) se llenan por JS.
    expect(evals.some(js => js.includes("getElementById('clave').value"))).toBe(true);
    // Un click sintético en el botón no dispara el onsubmit del form: hay que
    // usar requestSubmit().
    expect(evals.some(js => js.includes('requestSubmit'))).toBe(true);
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('si el formulario nunca aparece, lanza un error distinto al de credenciales', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, false);

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow(
      'El SII no mostró el formulario de autenticación'
    );
  });

  it('éxito: la URL final sale del login y cae en un dominio sii.cl, no lanza', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot, 'https://misiir.sii.cl/cgi_misii/siihome.cgi');

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).resolves.toBeDefined();
  });

  it('selecciona empresa por SII_EMPRESA_RUT si hay multiples', async () => {
    const config = { ...configClave, empresaRut: '11111111-1' };
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    await conTimers(() => mgr.login());

    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '11111111-1');
  });

  it('lanza error accionable si hay multiples empresas y no hay SII_EMPRESA_RUT', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await expect(conTimers(() => mgr.login())).rejects.toThrow('SII_EMPRESA_RUT');
  });

  // Bug real en prod: el SII no manda ningún error ante clave incorrecta acá
  // (a diferencia del CGI de certificado) — sólo vuelve a renderizar la MISMA
  // página de login, que se detecta porque la URL sigue conteniendo el
  // recurso del formulario (IngresoRutClave).
  it('clave rechazada: la URL sigue en IngresoRutClave, lanza error clasificable', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue(
      'https://homer.sii.cl/cgi-bin/IngresoRutClave.cgi'
    );

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });

  // Login lento pero exitoso: la URL sigue en el login en los primeros polls
  // (el SII todavía está procesando el submit) y recién en uno posterior sale
  // a un dominio sii.cl. No debe clasificarse como rechazo sólo porque no
  // salió en el primer poll.
  it('clave válida con login lento: sale del form recién en un poll posterior, no rechaza', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock)
      .mockReturnValueOnce('https://homer.sii.cl/cgi-bin/IngresoRutClave.cgi')
      .mockReturnValueOnce('https://homer.sii.cl/cgi-bin/IngresoRutClave.cgi')
      .mockReturnValue('https://mipyme.sii.cl/');
    (browser.snapshot as jest.Mock).mockReturnValue(empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    const session = await conTimers(() => mgr.login());

    expect(session.empresaRut).toBe('11111111-1');
  });

  // Cubre el caso que este mismo criterio podía introducir: la URL ya no
  // contiene IngresoRutClave, pero tampoco es un dominio sii.cl — una página
  // de error o mantención ajena. Sin este chequeo, cualquier interstitial
  // fuera del login volvería a reportar éxito con credenciales inválidas.
  it('la URL sale del login pero el destino no es sii.cl: rechaza igual', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://error-generico.example.com/');

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });
});

describe('SessionManager.getSession', () => {
  it('reutiliza la sesion cacheada sin hacer login nuevamente', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.getSession());
    await conTimers(() => mgr.getSession());

    // login abre SII_PORTAL_PRIVADO + selectEmpresa abre SII_SEL_EMPRESA_URL = 2 calls en total.
    // El segundo getSession() usa la caché y no llama open.
    expect(browser.open).toHaveBeenCalledTimes(2);
  });

  // El parámetro por llamada es la máxima prioridad: es la intención explícita
  // de quien invoca la tool, así que debe ganarle incluso a SII_EMPRESA_RUT.
  it('con varias empresas, resuelve por el empresaRut del parámetro aunque no haya SII_EMPRESA_RUT', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);
    const session = await conTimers(() => mgr.getSession('22222222-2'));

    expect(session.empresaRut).toBe('22222222-2');
    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '22222222-2');
  });

  it('con varias empresas, resuelve por SII_EMPRESA_RUT si no viene el parámetro', async () => {
    const config = { ...configClave, empresaRut: '22222222-2' };
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    const session = await conTimers(() => mgr.getSession());

    expect(session.empresaRut).toBe('22222222-2');
  });

  it('con varias empresas y ninguna resolución disponible, el error lista las empresas y menciona ambas salidas', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);

    let mensaje = '';
    try {
      await conTimers(() => mgr.getSession());
    } catch (err) {
      mensaje = err instanceof Error ? err.message : String(err);
    }

    expect(mensaje).toMatch(/empresa_rut/);
    expect(mensaje).toMatch(/SII_EMPRESA_RUT/);
    expect(mensaje).toMatch(/11111111-1 — EMPRESA UNO SPA/);
    expect(mensaje).toMatch(/22222222-2 — EMPRESA DOS LTDA/);
  });

  it('con una sola empresa y nada configurado, resuelve sin pedir nada', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    const session = await conTimers(() => mgr.getSession());

    expect(session.empresaRut).toBe('11111111-1');
  });

  // La rama de varias empresas valida que el RUT pedido esté en la lista; la
  // rama de una sola empresa seleccionaba lo que hubiera sin comparar contra
  // el RUT pedido. Con una única empresa disponible y un empresa_rut
  // explícito que no coincide, debe fallar igual que la rama multi — no
  // quedar seleccionada en la empresa equivocada devolviendo datos que
  // parecen buenos.
  it('con una sola empresa disponible, rechaza un empresaRut pedido que no coincide', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.getSession('22222222-2'))).rejects.toThrow(/no encontrada/);
    // Nunca debe seleccionar la empresa 1 como si fuera la 2 pedida.
    expect(browser.select).not.toHaveBeenCalledWith(expect.any(String), '11111111-1');
  });

  // selectEmpresa() debe esperar los mismos marcadores que
  // listEmpresasDisponibles() antes de leer el combo. Sin esa espera, un
  // render lento deja el snapshot sin opciones y, si hay una empresa
  // preferida configurada, se fabricaría una sesión "seleccionada" sin haber
  // tocado el navegador — y quedaría cacheada como válida para siempre.
  it('si la página de selección no rindió, falla en vez de fabricar una sesión', async () => {
    const config = { ...configClave, empresaRut: '11111111-1' };
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, '- generic\n  - StaticText "Cargando"');

    const mgr = new SessionManager(config, browser);

    await expect(conTimers(() => mgr.getSession())).rejects.toThrow(/no terminó de cargar/);
    expect(browser.select).not.toHaveBeenCalled();
  });

  // Pedir otra empresa mientras hay sesión cacheada debe cambiar de empresa sin
  // reautenticar: una segunda autenticación del mismo RUT dispara el bloqueo
  // del SII (01.01.190.500.720.27).
  it('pedir una empresa distinta a la cacheada cambia de empresa sin reautenticar', async () => {
    const config = { ...configClave, empresaRut: '11111111-1' };
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    await conTimers(() => mgr.getSession()); // login inicial, empresa 1

    const loginOpensAntes = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave|siihome/.test(url)).length;

    const session = await conTimers(() => mgr.getSession('22222222-2'));

    const loginOpensDespues = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave|siihome/.test(url)).length;

    expect(session.empresaRut).toBe('22222222-2');
    expect(loginOpensDespues).toBe(loginOpensAntes); // ninguna autenticación nueva
  });
});

describe('SessionManager.obtenerBrowser', () => {
  it('devuelve el Browser con el que se construyó la sesión', () => {
    const browser = crearBrowserMock();
    const mgr = new SessionManager(configClave, browser);
    expect(mgr.obtenerBrowser()).toBe(browser);
  });
});
