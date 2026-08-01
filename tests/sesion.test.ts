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

function makeSession() {
  const browser = new MockBrowser();
  (browser.snapshot as jest.Mock).mockReturnValue(loginSnapshot);
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
