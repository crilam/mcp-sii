import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

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

describe('SessionManager.login', () => {
  it('llama open, fill rut, fill clave y click en login', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await mgr.login();

    expect(browser.open).toHaveBeenCalledWith(expect.stringContaining('sii.cl'));
    expect(browser.fill).toHaveBeenCalledWith(expect.any(String), '12345678');
    expect(browser.fill).toHaveBeenCalledWith(expect.any(String), 'mipass');
    expect(browser.click).toHaveBeenCalled();
  });

  it('selecciona empresa por SII_EMPRESA_RUT si hay multiples', async () => {
    const config = { ...configClave, empresaRut: '11111111-1' };
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    await mgr.login();

    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '11111111-1');
  });

  it('lanza error accionable si hay multiples empresas y no hay SII_EMPRESA_RUT', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await expect(mgr.login()).rejects.toThrow('SII_EMPRESA_RUT');
  });
});

describe('SessionManager.getSession', () => {
  it('reutiliza la sesion cacheada sin hacer login nuevamente', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock).mockReturnValue(empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await mgr.getSession();
    await mgr.getSession();

    // login abre SII_LOGIN_URL + selectEmpresa abre SII_MIPYME_URL = 2 calls en total.
    // El segundo getSession() usa la caché y no llama open.
    expect(browser.open).toHaveBeenCalledTimes(2);
  });

  // El parámetro por llamada es la máxima prioridad: es la intención explícita
  // de quien invoca la tool, así que debe ganarle incluso a SII_EMPRESA_RUT.
  it('con varias empresas, resuelve por el empresaRut del parámetro aunque no haya SII_EMPRESA_RUT', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);
    const session = await mgr.getSession('22222222-2');

    expect(session.empresaRut).toBe('22222222-2');
    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '22222222-2');
  });

  it('con varias empresas, resuelve por SII_EMPRESA_RUT si no viene el parámetro', async () => {
    const config = { ...configClave, empresaRut: '22222222-2' };
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    const session = await mgr.getSession();

    expect(session.empresaRut).toBe('22222222-2');
  });

  it('con varias empresas y ninguna resolución disponible, el error lista las empresas y menciona ambas salidas', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);

    let mensaje = '';
    try {
      await mgr.getSession();
    } catch (err) {
      mensaje = err instanceof Error ? err.message : String(err);
    }

    expect(mensaje).toMatch(/empresa_rut/);
    expect(mensaje).toMatch(/SII_EMPRESA_RUT/);
    expect(mensaje).toMatch(/11111111-1 — EMPRESA UNO SPA/);
    expect(mensaje).toMatch(/22222222-2 — EMPRESA DOS LTDA/);
  });

  it('con una sola empresa y nada configurado, resuelve sin pedir nada', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    const session = await mgr.getSession();

    expect(session.empresaRut).toBe('11111111-1');
  });

  // La rama de varias empresas valida que el RUT pedido esté en la lista; la
  // rama de una sola empresa seleccionaba lo que hubiera sin comparar contra
  // el RUT pedido. Con una única empresa disponible y un empresa_rut
  // explícito que no coincide, debe fallar igual que la rama multi — no
  // quedar seleccionada en la empresa equivocada devolviendo datos que
  // parecen buenos.
  it('con una sola empresa disponible, rechaza un empresaRut pedido que no coincide', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);

    await expect(mgr.getSession('22222222-2')).rejects.toThrow(/no encontrada/);
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
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce('- generic\n  - StaticText "Cargando"');

    const mgr = new SessionManager(config, browser);

    await expect(mgr.getSession()).rejects.toThrow(/no terminó de cargar/);
    expect(browser.select).not.toHaveBeenCalled();
  });

  // Pedir otra empresa mientras hay sesión cacheada debe cambiar de empresa sin
  // reautenticar: una segunda autenticación del mismo RUT dispara el bloqueo
  // del SII (01.01.190.500.720.27).
  it('pedir una empresa distinta a la cacheada cambia de empresa sin reautenticar', async () => {
    const config = { ...configClave, empresaRut: '11111111-1' };
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(loginSnapshot)
      .mockReturnValueOnce(dosEmpresasSnapshot)
      .mockReturnValueOnce(dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    await mgr.getSession(); // login inicial, empresa 1

    const loginOpensAntes = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave/.test(url)).length;

    const session = await mgr.getSession('22222222-2');

    const loginOpensDespues = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave/.test(url)).length;

    expect(session.empresaRut).toBe('22222222-2');
    expect(loginOpensDespues).toBe(loginOpensAntes); // ninguna autenticación nueva
  });
});

describe('SessionManager.obtenerBrowser', () => {
  it('devuelve el Browser con el que se construyó la sesión', () => {
    const browser = new MockBrowser();
    const mgr = new SessionManager(configClave, browser);
    expect(mgr.obtenerBrowser()).toBe(browser);
  });
});
