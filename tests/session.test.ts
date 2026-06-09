import { SessionManager, SiiSession } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

const configClave: SiiConfig = {
  rut: '12345678',
  strategy: AuthStrategy.Clave,
  clave: 'mipass',
};

const configCert: SiiConfig = {
  rut: '12345678',
  strategy: AuthStrategy.Certificate,
  certPath: '/ruta/cert.pfx',
  certPassword: 'certpass',
};

describe('SessionManager.login', () => {
  it('llama open, fill rut, fill clave y click en login', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce('[input @e1 "RUT"] [input @e2 "Clave"] [button @e3 "Ingresar"]')
      .mockReturnValueOnce('[select @e10 "Empresa"] [option "EMPRESA A" value="11111111"]');
    (browser.getText as jest.Mock).mockReturnValue('EMPRESA A');

    const mgr = new SessionManager(configClave, browser);
    await mgr.login();

    expect(browser.open).toHaveBeenCalledWith(expect.stringContaining('sii.cl'));
    expect(browser.fill).toHaveBeenCalledWith(expect.any(String), '12345678');
    expect(browser.fill).toHaveBeenCalledWith(expect.any(String), 'mipass');
    expect(browser.click).toHaveBeenCalled();
  });

  it('selecciona empresa por SII_EMPRESA_RUT si hay multiples', async () => {
    const config = { ...configClave, empresaRut: '11111111' };
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce('[input @e1 "RUT"] [input @e2 "Clave"] [button @e3 "Ingresar"]')
      .mockReturnValueOnce('[select @e10 "Empresa"] [option "EMP A" value="11111111"] [option "EMP B" value="22222222"]');

    const mgr = new SessionManager(config, browser);
    await mgr.login();

    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '11111111');
  });

  it('lanza error accionable si hay multiples empresas y no hay SII_EMPRESA_RUT', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce('[input @e1 "RUT"] [input @e2 "Clave"] [button @e3 "Ingresar"]')
      .mockReturnValueOnce('[select @e10 "Empresa"] [option "EMP A" value="11111111"] [option "EMP B" value="22222222"]');

    const mgr = new SessionManager(configClave, browser);
    await expect(mgr.login()).rejects.toThrow('SII_EMPRESA_RUT');
  });
});

describe('SessionManager.getSession', () => {
  it('reutiliza la sesion cacheada sin hacer login nuevamente', async () => {
    const browser = new MockBrowser();
    (browser.snapshot as jest.Mock).mockReturnValue('[select @e10 "Empresa"] [option "EMP" value="11111111"]');

    const mgr = new SessionManager(configClave, browser);
    await mgr.getSession();
    await mgr.getSession();

    expect(browser.open).toHaveBeenCalledTimes(1);
  });
});
