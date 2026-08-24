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

// El jar es por INSTANCIA de sesión (RUT + un id único), no una ruta fija: dos
// sesiones del mismo RUT no deben compartir archivo. Así que el test le pregunta
// la ruta a la sesión en vez de reconstruirla.
function rutaDe(mgr: SessionManager): string {
  return (mgr as unknown as { cookieJar: string }).cookieJar;
}

const escritos: string[] = [];

function escribirCookieJar(mgr: SessionManager, lineas: string[]): void {
  const ruta = rutaDe(mgr);
  escritos.push(ruta);
  fs.writeFileSync(
    ruta,
    ['# Netscape HTTP Cookie File', '', ...lineas].join('\n'),
    'utf-8'
  );
}

function cookie(nombre: string, valor: string): string {
  return ['.sii.cl', 'TRUE', '/', 'TRUE', '0', nombre, valor].join('\t');
}

afterEach(() => {
  for (const ruta of escritos.splice(0)) {
    try { fs.unlinkSync(ruta); } catch { /* no existía */ }
  }
});

// El conversationId del sobre SDI es el valor de la cookie TOKEN. Vive en
// SessionManager porque es el dueño del cookie jar: el cliente HTTP no debe
// leer el archivo por su cuenta.
describe('SessionManager.conversationId', () => {
  it('devuelve el valor de la cookie TOKEN del cookie jar', () => {
    const mgr = new SessionManager(config, new MockBrowser());
    escribirCookieJar(mgr, [
      cookie('CSESSIONID', 'sesion-abc'),
      cookie('TOKEN', 'token-de-la-sesion'),
    ]);

    expect(mgr.conversationId()).toBe('token-de-la-sesion');
  });

  // Mandar el sobre con un conversationId vacío devuelve "Acceso no
  // autorizado!", que manda a revisar permisos cuando no hay sesión.
  it('falla con un mensaje claro si no hay cookie TOKEN', () => {
    const mgr = new SessionManager(config, new MockBrowser());
    escribirCookieJar(mgr, [cookie('CSESSIONID', 'sesion-abc')]);

    expect(() => mgr.conversationId()).toThrow(/TOKEN/);
  });

  it('falla con un mensaje claro si no hay cookie jar', () => {
    // No se escribe ninguno: cada sesión tiene su propia ruta, así que la de
    // esta instancia no existe.
    const mgr = new SessionManager(config, new MockBrowser());

    expect(() => mgr.conversationId()).toThrow(/TOKEN/);
  });
});
