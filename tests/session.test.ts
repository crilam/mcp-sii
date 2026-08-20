import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

// El polling de login (esperarSalirDelFormularioDeLogin) usa setTimeout real
// — con fake timers global + runAllTimersAsync, cualquier test que dispare
// ese polling (éxito con 2 lecturas limpias, o rechazo agotando 15s) avanza
// sin pagar tiempo real, sin que cada test tenga que calcular a mano cuántos
// ms exactos hacen falta.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

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

// Snapshot de página de login (formato accessibility tree)
const loginSnapshot = [
  '- textbox "Ingrese su RUT" [ref=e1]',
  '- textbox "Ingrese su Clave" [ref=e2]',
  '- button "Ingresar" [ref=e3]',
].join('\n');

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

// Tras el login, fillClaveForm vuelve a leer el snapshot DOS veces seguidas
// para confirmar que el campo de clave desapareció (ver
// esperarSalirDelFormularioDeLogin en src/session.ts — exige 2 lecturas
// limpias consecutivas, no 1, para no confundir un DOM a mitad de re-render
// con un login exitoso), y la URL para confirmar que el destino es un
// dominio de sii.cl. Con `mockReturnValueOnce(loginSnapshot).mockReturnValue
// (snapshotFinal)`, la primera lectura sigue siendo el form de login y TODAS
// las lecturas posteriores (las 2 del chequeo post-click, más las de
// selección de empresa) usan `snapshotFinal`.
function mockearLoginExitoso(browser: Browser, snapshotFinal: string): void {
  (browser.snapshot as jest.Mock)
    .mockReturnValueOnce(loginSnapshot)
    .mockReturnValue(snapshotFinal);
  (browser.eval as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
}

describe('SessionManager.login', () => {
  it('llama open, fill rut, fill clave y click en login', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    expect(browser.open).toHaveBeenCalledWith(expect.stringContaining('sii.cl'));
    expect(browser.fill).toHaveBeenCalledWith(expect.any(String), '12345678');
    expect(browser.fill).toHaveBeenCalledWith(expect.any(String), 'mipass');
    expect(browser.click).toHaveBeenCalled();
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
  // página de login. Sin verificar esto, fillClaveForm daba por exitoso
  // cualquier clave, y validarClave (endpoint de Tributy) reportaba
  // {ok:true} con credenciales inválidas.
  //
  // La verificación es por CONTENIDO del snapshot (¿sigue el campo de clave?),
  // no por URL: una primera versión chequeaba document.location.href, pero
  // una clave VÁLIDA confirmada por el usuario también quedó atrapada — el
  // SII no navega a otra URL en este flujo, re-renderiza sobre la misma.
  it('clave rechazada: el campo de clave sigue en el snapshot tras el click, lanza error clasificable', async () => {
    const browser = crearBrowserMock();
    // El campo de clave NUNCA desaparece: cada snapshot post-click sigue
    // siendo la misma página de login.
    (browser.snapshot as jest.Mock).mockReturnValue(loginSnapshot);

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });

  // Fail-safe: un snapshot vacío/basura del CLI (falla de agent-browser, no
  // del SII) nunca debe interpretarse como "el campo de clave desapareció" —
  // si no, un error de infraestructura se reportaría como login exitoso.
  it('snapshot vacío tras el click (falla del CLI, no del SII): no lo cuenta como éxito', async () => {
    const browser = crearBrowserMock();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValue('');

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });

  // Login lento pero exitoso: el campo de clave sigue presente en los
  // primeros chequeos (el SII todavía está procesando el submit) y recién
  // desaparece más adelante, dentro del margen de 15s. No debe clasificarse
  // como rechazo sólo porque no desapareció en el primer poll.
  it('clave válida con login lento: el campo desaparece recién en un poll posterior, no rechaza', async () => {
    const browser = crearBrowserMock();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot) // lectura inicial del form
      .mockReturnValueOnce(loginSnapshot) // 1er poll: SII todavía procesando
      .mockReturnValueOnce(loginSnapshot) // 2do poll: sigue procesando
      .mockReturnValue(empresaUnicaSnapshot); // 3er poll en adelante: ya avanzó (2 lecturas limpias)
    (browser.eval as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');

    const mgr = new SessionManager(configClave, browser);
    const session = await conTimers(() => mgr.login());

    expect(session.empresaRut).toBe('11111111-1');
  });

  // Cubre el caso que este mismo fix podía reintroducir: el campo de clave
  // desaparece (login "avanzó"), pero el destino no es un dominio de sii.cl
  // — una página de error o mantención ajena. Sin este chequeo, cualquier
  // interstitial sin form volvería a reportar éxito con credenciales
  // inválidas.
  it('el campo de clave desaparece pero el destino no es sii.cl: rechaza igual', async () => {
    const browser = crearBrowserMock();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValue('- generic\n  - StaticText "Página no disponible"');
    (browser.eval as jest.Mock).mockReturnValue('https://error-generico.example.com/');

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });

  // El chequeo de "campo de clave" exige rol de INPUT (textbox/password), no
  // cualquier elemento que mencione la palabra — un link post-login como
  // "Cambiar clave" (existe en el menú de MiSII) no debe confundirse con el
  // formulario de login todavía presente.
  it('un link "Cambiar clave" post-login no cuenta como el formulario de login', async () => {
    const browser = crearBrowserMock();
    const snapshotConLinkCambiarClave = [
      '- generic',
      '  - StaticText "Bienvenido"',
      '  - link "Cambiar clave" [ref=e20]',
    ].join('\n');
    mockearLoginExitoso(browser, snapshotConLinkCambiarClave);

    const mgr = new SessionManager(configClave, browser);

    // No debe rechazar por clave: si el link se confundiera con el campo,
    // esto lanzaría "El SII rechazó la autenticación" acá. La excepción que
    // sí sale es la de selección de empresa (no hay combobox en este
    // snapshot) — prueba de que el login-phase pasó de largo sin problema.
    await expect(conTimers(() => mgr.login())).rejects.toThrow(/no terminó de cargar/);
  });
});

describe('SessionManager.getSession', () => {
  it('reutiliza la sesion cacheada sin hacer login nuevamente', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.getSession());
    await conTimers(() => mgr.getSession());

    // login abre SII_LOGIN_URL + selectEmpresa abre SII_MIPYME_URL = 2 calls en total.
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
      .filter(([url]) => /IngresoRutClave/.test(url)).length;

    const session = await conTimers(() => mgr.getSession('22222222-2'));

    const loginOpensDespues = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave/.test(url)).length;

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
