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
});
