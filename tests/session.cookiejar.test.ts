import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');
jest.mock('child_process');
jest.mock('fs');

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;
const mockExec = execSync as jest.MockedFunction<typeof execSync>;

const configCert: SiiConfig = {
  rut: '12345678',
  strategy: AuthStrategy.Certificate,
  certPath: '/ruta/cert.pfx',
  certPassword: 'clave-pfx',
};

const RESPUESTA_OK = "<script>location.replace('https://mipyme.sii.cl/')</script>";

beforeEach(() => {
  jest.clearAllMocks();
  mockExec.mockImplementation(((cmd: string) => {
    if (/version/.test(cmd)) return 'OpenSSL 3.2.0 \n';
    if (/pkcs12/.test(cmd)) return '';
    if (/curl/.test(cmd)) return RESPUESTA_OK;
    return '';
  }) as unknown as typeof execSync);
});

describe('SessionManager.rutaCookieJar', () => {
  it('devuelve un cookie jar propio de la credencial, no uno global', async () => {
    // El jar lleva el RUT: dos credenciales no pueden compartir archivo, o la
    // segunda pisaría la sesión de la primera (multi-tenant).
    const mgr = new SessionManager(configCert, new MockBrowser());

    const ruta = await mgr.rutaCookieJar();

    expect(ruta).toBe(path.join(os.tmpdir(), 'sii_cookies_12345678'));
  });

  it('dos credenciales distintas no comparten cookie jar', async () => {
    const otra = new SessionManager(
      { ...configCert, rut: '99999999-9' },
      new MockBrowser()
    );
    const mgr = new SessionManager(configCert, new MockBrowser());

    expect(await mgr.rutaCookieJar()).not.toBe(await otra.rutaCookieJar());
  });

  // Si el cliente HTTP autenticara por su cuenta, el proceso abriría dos
  // sesiones y el SII bloquearía el RUT (01.01.190.500.720.27).
  it('reusa la sesión ya abierta en vez de autenticar de nuevo', async () => {
    const mgr = new SessionManager(configCert, new MockBrowser());

    await mgr.authenticateOnly();
    await mgr.rutaCookieJar();
    await mgr.rutaCookieJar();

    const autenticaciones = mockExec.mock.calls.filter(([cmd]) =>
      /curl/.test(String(cmd))
    );
    expect(autenticaciones).toHaveLength(1);
  });

  it('parte el RUT en cuerpo y dígito verificador', () => {
    const mgr = new SessionManager({ ...configCert, rut: '11111111-1' }, new MockBrowser());

    expect(mgr.identidad()).toEqual({ rut: '11111111', dv: '1' });
  });

  it('acepta el RUT sin guión y normaliza el DV a mayúscula', () => {
    const mgr = new SessionManager({ ...configCert, rut: '12345678k' }, new MockBrowser());

    expect(mgr.identidad()).toEqual({ rut: '12345678', dv: 'K' });
  });

  // Sólo loginWithCert escribe el cookie jar. Con clave tributaria el archivo
  // nunca existe, y devolver la ruta igual hacía que las tools por HTTP
  // fallaran siempre con "la sesión pudo expirar" — o, si en esa máquina hubo
  // antes una corrida con certificado, que curl mandara cookies rancias y
  // disparara el bloqueo del SII por exceso de sesiones.
  it('falla con un mensaje accionable si la estrategia es clave', async () => {
    const mgr = new SessionManager(
      { rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'secreta' },
      new MockBrowser()
    );

    await expect(mgr.rutaCookieJar()).rejects.toThrow(/certificado digital/);
    await expect(mgr.rutaCookieJar()).rejects.toThrow(/SII_CERT_PATH/);
  });

  it('no autentica ni abre el navegador cuando la estrategia es clave', async () => {
    const browser = new MockBrowser();
    const mgr = new SessionManager(
      { rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'secreta' },
      browser
    );

    await expect(mgr.rutaCookieJar()).rejects.toThrow();

    expect(browser.open).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('autentica si todavía no hay sesión', async () => {
    const mgr = new SessionManager(configCert, new MockBrowser());

    await mgr.rutaCookieJar();

    const autenticaciones = mockExec.mock.calls.filter(([cmd]) =>
      /curl/.test(String(cmd))
    );
    expect(autenticaciones).toHaveLength(1);
  });
});
