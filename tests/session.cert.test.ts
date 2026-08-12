import * as fs from 'fs';
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
const mockUnlink = fs.unlinkSync as jest.MockedFunction<typeof fs.unlinkSync>;

const configCert: SiiConfig = {
  rut: '12345678',
  strategy: AuthStrategy.Certificate,
  certPath: '/ruta/cert.pfx',
  certPassword: 'clave-pfx',
};

// Los PEM temporales ahora son por credencial (llevan el RUT saneado), para
// que dos logins concurrentes de RUTs distintos no se pisen el material de
// clave. Para el RUT de este test (12345678) el sufijo es "12345678".
const KEY_PEM = path.join(os.tmpdir(), 'sii_key_12345678');
const CERT_PEM = path.join(os.tmpdir(), 'sii_cert_12345678');

// Respuesta del CGI cuando la autenticación fue aceptada.
const RESPUESTA_OK = "<script>location.replace('https://mipyme.sii.cl/')</script>";

// El CGI responde 200 incluso al rechazar: el error viaja en un alert().
const RESPUESTA_RECHAZO =
  "<script>alert('Su certificado digital se encuentra vencido')</script>";

function prepararExec(respuestaCgi: string): void {
  mockExec.mockImplementation(((cmd: string) => {
    if (/version/.test(cmd)) return 'OpenSSL 3.2.0 \n';
    if (/pkcs12/.test(cmd)) return '';
    if (/curl/.test(cmd)) return respuestaCgi;
    return '';
  }) as unknown as typeof execSync);
}

beforeEach(() => {
  jest.clearAllMocks();
  (fs.readFileSync as jest.Mock).mockReturnValue('');
});

// La clave privada se extrae del .pfx con -nodes, o sea sin cifrar, a un
// directorio compartido. Si la limpieza queda después de una validación que
// lanza, el rechazo de autenticación deja material de clave reutilizable en
// disco justo cuando algo salió mal.
describe('SessionManager: limpieza de los PEM temporales', () => {
  it('borra la clave privada cuando la autenticación es exitosa', async () => {
    prepararExec(RESPUESTA_OK);
    const mgr = new SessionManager(configCert, new MockBrowser());

    await mgr.authenticateOnly();

    expect(mockUnlink).toHaveBeenCalledWith(KEY_PEM);
    expect(mockUnlink).toHaveBeenCalledWith(CERT_PEM);
  });

  it('borra la clave privada aunque el SII rechace la autenticación', async () => {
    prepararExec(RESPUESTA_RECHAZO);
    const mgr = new SessionManager(configCert, new MockBrowser());

    await expect(mgr.authenticateOnly()).rejects.toThrow('vencido');

    expect(mockUnlink).toHaveBeenCalledWith(KEY_PEM);
    expect(mockUnlink).toHaveBeenCalledWith(CERT_PEM);
  });

  it('borra la clave privada aunque curl falle', async () => {
    mockExec.mockImplementation(((cmd: string) => {
      if (/version/.test(cmd)) return 'OpenSSL 3.2.0 \n';
      if (/pkcs12/.test(cmd)) return '';
      throw new Error('curl: (35) SSL connect error');
    }) as unknown as typeof execSync);
    const mgr = new SessionManager(configCert, new MockBrowser());

    await expect(mgr.authenticateOnly()).rejects.toThrow();

    expect(mockUnlink).toHaveBeenCalledWith(KEY_PEM);
  });
});

// El servidor MCP vive mucho más que la sesión del SII: el propio CGI le da a
// `locexp` dos horas. Si la marca de autenticado no caduca con ella, las
// consultas posteriores saltan el login, van a una página protegida y fallan
// igual en cada reintento hasta reiniciar el proceso.
describe('SessionManager: caducidad de la autenticación', () => {
  const DOS_HORAS_MS = 7_200_000;

  afterEach(() => jest.useRealTimers());

  it('reautentica cuando la sesión del SII ya caducó', async () => {
    jest.useFakeTimers();
    prepararExec(RESPUESTA_OK);
    const mgr = new SessionManager(configCert, new MockBrowser());

    await mgr.authenticateOnly();
    jest.advanceTimersByTime(DOS_HORAS_MS + 1_000);
    await mgr.authenticateOnly();

    const autenticaciones = mockExec.mock.calls.filter(([cmd]) =>
      /curl/.test(String(cmd))
    );
    expect(autenticaciones).toHaveLength(2);
  });

  it('reutiliza la sesión mientras siga vigente', async () => {
    jest.useFakeTimers();
    prepararExec(RESPUESTA_OK);
    const mgr = new SessionManager(configCert, new MockBrowser());

    await mgr.authenticateOnly();
    jest.advanceTimersByTime(DOS_HORAS_MS / 2);
    await mgr.authenticateOnly();

    const autenticaciones = mockExec.mock.calls.filter(([cmd]) =>
      /curl/.test(String(cmd))
    );
    expect(autenticaciones).toHaveLength(1);
  });
});
