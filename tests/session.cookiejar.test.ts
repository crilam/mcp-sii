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

    expect(ruta.startsWith(path.join(os.tmpdir(), 'sii_cookies_12345678'))).toBe(true);
  });

  // Y tampoco lo comparten dos sesiones del MISMO RUT. `ejecutarPassThrough`
  // crea a propósito una sesión que no se cachea, así que puede coexistir con la
  // cacheada: con el jar por RUT, cerrar una le borraba el archivo a la otra, que
  // seguía creyéndose autenticada y salía sin cookies.
  it('dos sesiones del mismo RUT no comparten cookie jar', async () => {
    const a = new SessionManager(configCert, new MockBrowser());
    const b = new SessionManager(configCert, new MockBrowser());

    expect(await a.rutaCookieJar()).not.toBe(await b.rutaCookieJar());
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
  // Antes esto se rechazaba exigiendo certificado. Era una limitación nuestra,
  // no del SII: el navegador tiene las cookies y nadie las escribía. Verificado
  // contra el portal que sirven para las consultas por HTTP.
  it('con estrategia de clave entrega el jar, no lo rechaza', async () => {
    const browser = new MockBrowser();
    // El jar arranca con la sesión anterior y queda limpio tras el borrado: el
    // login VERIFICA la limpieza y aborta si sobrevive una cookie de sesión, así
    // que un mock que devuelva siempre lo mismo haría fallar todo login.
    let jar = [{ name: 'TOKEN', domain: '.sii.cl', path: '/', tieneValor: true }];
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => jar);
    (browser.borrarCookies as jest.Mock).mockImplementation(() => { jar = []; });
    (browser.eval as jest.Mock).mockImplementation((js: string) => {
      if (js.includes('requestSubmit')) {
        jar = [{ name: 'TOKEN', domain: '.sii.cl', path: '/', tieneValor: true }];
      }
      return js.includes("getElementById('myform')") ? 'SI' : '';
    });
    (browser.escribirCookieJar as jest.Mock).mockReturnValue(14);
    const mgr = new SessionManager(
      { rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'secreta' },
      browser
    );

    await expect(mgr.rutaCookieJar()).resolves.toContain('111111111');
    // Y el jar quedó escrito con las cookies del navegador.
    expect(browser.escribirCookieJar).toHaveBeenCalled();
  });

  // Si el login se verificó exitoso pero no se pudo exportar ninguna cookie,
  // fallar es mejor que devolver la ruta de un archivo vacío: con el archivo
  // presente y sin cookies, curl sale sin autenticación y el error termina
  // reportado como sesión caducada, que apunta al lugar equivocado.
  it('falla si no se pudo exportar ninguna cookie al jar', async () => {
    const browser = new MockBrowser();
    // El jar arranca con la sesión anterior y queda limpio tras el borrado: el
    // login VERIFICA la limpieza y aborta si sobrevive una cookie de sesión, así
    // que un mock que devuelva siempre lo mismo haría fallar todo login.
    let jar = [{ name: 'TOKEN', domain: '.sii.cl', path: '/', tieneValor: true }];
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => jar);
    (browser.borrarCookies as jest.Mock).mockImplementation(() => { jar = []; });
    (browser.eval as jest.Mock).mockImplementation((js: string) => {
      if (js.includes('requestSubmit')) {
        jar = [{ name: 'TOKEN', domain: '.sii.cl', path: '/', tieneValor: true }];
      }
      return js.includes("getElementById('myform')") ? 'SI' : '';
    });
    (browser.escribirCookieJar as jest.Mock).mockReturnValue(0);
    const mgr = new SessionManager(
      { rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'secreta' },
      browser
    );

    await expect(mgr.rutaCookieJar()).rejects.toThrow(/no se pudo exportar ninguna cookie/);
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
