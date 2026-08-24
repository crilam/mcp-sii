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
      () => new MockBrowser()
    );

    const sesion = await registro.ejecutar('11111111-1', async s => s);

    expect(sesion).toBeInstanceOf(SessionManager);
    // La credencial se usó: el cookie jar de esa sesión lleva el RUT de A.
    expect(await sesion.rutaCookieJar()).toContain('111111111');
  });

  it('da SessionManagers distintos para RUTs distintos', async () => {
    const registro = crearRegistroSesionesSii(
      new CredencialesEnMemoria([configA, configB]),
      () => new MockBrowser()
    );

    const a = await registro.ejecutar('11111111-1', async s => s);
    const b = await registro.ejecutar('22222222-2', async s => s);

    expect(a).not.toBe(b);
    expect(await a.rutaCookieJar()).not.toBe(await b.rutaCookieJar());
  });

  // Compartir un Browser entre RUTs comparte el contexto, o sea las COOKIES de
  // sesión del SII. Con eso, el login de un RUT podía ver la sesión de otro y
  // darse por exitoso con una credencial inválida, y su limpieza previa borraba
  // la sesión viva del otro sin que nada avisara.
  it('le da a cada RUT su propio contexto de navegador', async () => {
    const contextos: string[] = [];
    const registro = crearRegistroSesionesSii(
      new CredencialesEnMemoria([configA, configB]),
      id => { contextos.push(id); return new MockBrowser(); }
    );

    await registro.ejecutar('11111111-1', async s => s);
    await registro.ejecutar('22222222-2', async s => s);

    // El id lleva el RUT (para poder rastrear el contexto) más un correlativo
    // que lo hace único: la unicidad no puede depender del RUT, porque varias
    // sesiones del mismo RUT tampoco deben compartir contexto.
    expect(contextos).toHaveLength(2);
    expect(contextos[0]).toContain('111111111');
    expect(contextos[1]).toContain('222222222');
    expect(contextos[0]).not.toBe(contextos[1]);
  });

  // El bug que esto cierra: con `--session <rut>` a secas, la sesión que
  // `ejecutarPassThrough` crea nueva por request comparte contexto —o sea
  // cookies— con la cacheada del mismo RUT. Así, un `validar-clave` le borraba
  // la sesión viva a la instancia cacheada (que seguía creyéndose autenticada
  // 2h, con el jar vacío y sin ningún error), y el chequeo de login de una podía
  // ver las cookies de la otra.
  it('no comparte contexto entre dos sesiones del mismo RUT', async () => {
    const contextos: string[] = [];
    const registro = crearRegistroSesionesSii(
      new CredencialesEnMemoria([configA]),
      id => { contextos.push(id); return new MockBrowser(); }
    );

    await registro.ejecutar('11111111-1', async s => s);
    await registro.ejecutarPassThrough('11111111-1', () => {}, () => {}, async s => s);

    expect(contextos).toHaveLength(2);
    expect(contextos[0]).not.toBe(contextos[1]);
    // Y los dos siguen identificando al RUT, para que el contexto sea rastreable.
    for (const id of contextos) expect(id).toContain('111111111');
  });

  it('cierra el contexto de la sesión del pase al terminar', async () => {
    const navegadores: Browser[] = [];
    const registro = crearRegistroSesionesSii(
      new CredencialesEnMemoria([configA]),
      () => { const b = new MockBrowser(); navegadores.push(b); return b; }
    );

    await registro.ejecutarPassThrough('11111111-1', () => {}, () => {}, async s => s);

    expect(navegadores).toHaveLength(1);
    expect(navegadores[0].close).toHaveBeenCalled();
  });

  it('propaga el error del proveedor cuando el RUT no está registrado', async () => {
    const registro = crearRegistroSesionesSii(
      new CredencialesEnMemoria([configA]),
      () => new MockBrowser()
    );

    // El registro normaliza el RUT antes de pedir la credencial, así que el
    // mensaje de error llega con el formato normalizado (sin puntos ni guión).
    await expect(registro.ejecutar('99999999-9', async s => s)).rejects.toThrow(/999999999/);
  });
});
