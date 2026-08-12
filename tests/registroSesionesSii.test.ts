import { execSync } from 'child_process';
import { crearRegistroSesionesSii } from '../src/registroSesionesSii';
import { CredencialesEnMemoria } from '../src/credenciales';
import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');
jest.mock('child_process');
jest.mock('fs');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;
const mockExec = execSync as jest.MockedFunction<typeof execSync>;

// rutaCookieJar autentica; con cert eso llama openssl y curl vía execSync. Se
// simulan para que el test no toque el disco ni la red: sólo verifica el
// cableado (qué credencial recibe cada sesión), no la autenticación real.
beforeEach(() => {
  jest.clearAllMocks();
  mockExec.mockImplementation(((cmd: string) => {
    if (/version/.test(cmd)) return 'OpenSSL 3.2.0 \n';
    if (/pkcs12/.test(cmd)) return '';
    if (/curl/.test(cmd)) return "<script>location.replace('https://mipyme.sii.cl/')</script>";
    return '';
  }) as unknown as typeof execSync);
});

const configA: SiiConfig = {
  rut: '11111111-1',
  strategy: AuthStrategy.Certificate,
  certPath: '/certs/a.pfx',
  certPassword: 'clave-a',
};
const configB: SiiConfig = {
  rut: '22222222-2',
  strategy: AuthStrategy.Certificate,
  certPath: '/certs/b.pfx',
  certPassword: 'clave-b',
};

describe('crearRegistroSesionesSii', () => {
  it('entrega un SessionManager armado con la credencial del RUT pedido', async () => {
    const registro = crearRegistroSesionesSii(
      new CredencialesEnMemoria([configA]),
      new MockBrowser()
    );

    const sesion = await registro.ejecutar('11111111-1', async s => s);

    expect(sesion).toBeInstanceOf(SessionManager);
    // La credencial se usó: el cookie jar de esa sesión lleva el RUT de A.
    expect(await sesion.rutaCookieJar()).toContain('111111111');
  });

  it('da SessionManagers distintos para RUTs distintos', async () => {
    const registro = crearRegistroSesionesSii(
      new CredencialesEnMemoria([configA, configB]),
      new MockBrowser()
    );

    const a = await registro.ejecutar('11111111-1', async s => s);
    const b = await registro.ejecutar('22222222-2', async s => s);

    expect(a).not.toBe(b);
    expect(await a.rutaCookieJar()).not.toBe(await b.rutaCookieJar());
  });

  it('propaga el error del proveedor cuando el RUT no está registrado', async () => {
    const registro = crearRegistroSesionesSii(
      new CredencialesEnMemoria([configA]),
      new MockBrowser()
    );

    await expect(registro.ejecutar('99999999-9', async s => s)).rejects.toThrow(/99999999-9/);
  });
});
