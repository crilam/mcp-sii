import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

const config: SiiConfig = {
  rut: '11111111-1',
  strategy: AuthStrategy.Certificate,
  certPath: '/ruta/cert.pfx',
  certPassword: 'clave-pfx',
};

// El cookie jar ahora es por credencial: lleva el RUT saneado a [A-Za-z0-9].
// Para el RUT de este test (11111111-1) eso es "111111111".
const COOKIE_JAR = path.join(os.tmpdir(), 'sii_cookies_111111111');

function escribirCookieJar(lineas: string[]): void {
  fs.writeFileSync(
    COOKIE_JAR,
    ['# Netscape HTTP Cookie File', '', ...lineas].join('\n'),
    'utf-8'
  );
}

function cookie(nombre: string, valor: string): string {
  return ['.sii.cl', 'TRUE', '/', 'TRUE', '0', nombre, valor].join('\t');
}

afterEach(() => {
  try { fs.unlinkSync(COOKIE_JAR); } catch { /* no existía */ }
});

// El conversationId del sobre SDI es el valor de la cookie TOKEN. Vive en
// SessionManager porque es el dueño del cookie jar: el cliente HTTP no debe
// leer el archivo por su cuenta.
describe('SessionManager.conversationId', () => {
  it('devuelve el valor de la cookie TOKEN del cookie jar', () => {
    escribirCookieJar([
      cookie('CSESSIONID', 'sesion-abc'),
      cookie('TOKEN', 'token-de-la-sesion'),
    ]);
    const mgr = new SessionManager(config, new MockBrowser());

    expect(mgr.conversationId()).toBe('token-de-la-sesion');
  });

  // Mandar el sobre con un conversationId vacío devuelve "Acceso no
  // autorizado!", que manda a revisar permisos cuando no hay sesión.
  it('falla con un mensaje claro si no hay cookie TOKEN', () => {
    escribirCookieJar([cookie('CSESSIONID', 'sesion-abc')]);
    const mgr = new SessionManager(config, new MockBrowser());

    expect(() => mgr.conversationId()).toThrow(/TOKEN/);
  });

  it('falla con un mensaje claro si no hay cookie jar', () => {
    try { fs.unlinkSync(COOKIE_JAR); } catch { /* no existía */ }
    const mgr = new SessionManager(config, new MockBrowser());

    expect(() => mgr.conversationId()).toThrow(/TOKEN/);
  });
});
