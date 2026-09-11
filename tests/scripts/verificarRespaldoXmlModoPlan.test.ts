import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// `ejecutarModoPlan` no tenía ningún test — los que hay corren contra
// `ejecutarPlan`, que no abre sesión ni cierra nada. Esta suite cubre justo
// el cierre: `credenciales.borrar()` tiene que correr SIEMPRE, incluso
// cuando `registro.cerrarYOlvidar()` (el cierre de la sesión del SII) lanza,
// porque sin el `finally` anidado un certificado real (perfil por defecto
// del script) podía quedar en disco si el cierre de sesión fallaba.
//
// Los dos `jest.mock` van a nivel de módulo, y `mockEjecutar`/`mockCerrarYOlvidar`
// se declaran ANTES para que las fábricas los puedan referenciar (la regla de
// hoisting de Jest permite nombres que empiecen con "mock").
const mockCerrarYOlvidar = jest.fn();
const mockEjecutar = jest.fn(async () => ({
  documentos: 1,
  tramos: [{ fechaDesde: '2026-01-01', fechaHasta: '2026-01-10', documentos: 1, xml: '<xml/>' }],
  limitaciones: [],
}));
// Reemplaza SÓLO `recorrerConRitmo` (con `requireActual` para el resto, ver
// abajo): es lo único que permite simular, en un test de integración real de
// `ejecutarModoPlan`, el escenario "algo revienta a mitad del plan" que
// `consultarRespaldoXml`/`ejecutarPlan` NO pueden producir por sí mismos —
// las dos capas de `try/catch` que protegen a cada consulta individual hacen
// que ninguna falla de negocio propague hasta acá.
const mockRecorrerConRitmo = jest.fn();
// Config MUTABLE que la fábrica de `perfil` lee en cada llamada: permite que
// un test puntual pida el perfil de certificado (para probar el cuarto
// argumento de `guardarCertificado`) sin depender de `NOMBRE`/`process.argv`,
// que este módulo fija UNA vez al importarse.
const mockPerfilConfig: { tipo: 'clave' | 'certificado' } = { tipo: 'clave' };

jest.mock('../../src/perfilesVerificacion', () => ({
  perfil: () => (
    mockPerfilConfig.tipo === 'certificado'
      ? {
        nombre: 'certificado-test',
        rut: '99999999-9',
        credencial: { tipo: 'certificado', certificadoBase64: 'YmFzZTY0', certificadoPassword: 'clave-pfx' },
      }
      : {
        nombre: 'mipyme',
        rut: '11111111-1',
        credencial: { tipo: 'clave', clave: 'clave-test' },
      }
  ),
}));

// Mockea el módulo que arma la sesión real del SII (login, Browser), no
// `ejecutarPlan`: así se prueba el código de VERDAD de `ejecutarModoPlan`
// (incluida `crearEjecutorDeUnaSesion`) y sólo se evita abrir un navegador
// real. El `ejecutar` mockeado ignora el callback que le pasa
// `consultarRespaldoXml` y devuelve directamente la forma que espera —
// suficiente para esta prueba, que no mira los documentos bajados sino la
// limpieza al final.
jest.mock('../../src/registroSesionesSii', () => ({
  crearRegistroSesionesSii: () => ({
    ejecutar: mockEjecutar,
    cerrarYOlvidar: mockCerrarYOlvidar,
  }),
}));

jest.mock('../../src/ritmoSii', () => ({
  ...jest.requireActual('../../src/ritmoSii'),
  recorrerConRitmo: mockRecorrerConRitmo,
}));

describe('ejecutarModoPlan (la credencial se borra siempre, aunque el cierre de sesión falle)', () => {
  let tmpDir: string;
  let rutaPlan: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let borrarSpy: jest.SpyInstance<any, any>;
  let ejecutarModoPlan: typeof import('../../src/scripts/verificarRespaldoXml').ejecutarModoPlan;

  beforeEach(() => {
    mockCerrarYOlvidar.mockReset();
    mockEjecutar.mockClear();
    mockPerfilConfig.tipo = 'clave';
    // Default: un equivalente MÍNIMO del `recorrerConRitmo` real (sin pausa,
    // no hace falta acá) — sólo llama `fn` en orden para cada item. Los tests
    // que necesitan simular un corte a mitad de camino lo sobreescriben.
    mockRecorrerConRitmo.mockReset();
    mockRecorrerConRitmo.mockImplementation(
      async (items: unknown[], fn: (item: unknown, i: number) => Promise<unknown>) => {
        const salida = [];
        for (const [i, item] of items.entries()) salida.push(await fn(item, i));
        return salida;
      }
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-plan-modo-'));
    rutaPlan = path.join(tmpDir, 'plan.json');
    fs.writeFileSync(rutaPlan, JSON.stringify({ consultas: [{}] }), 'utf-8');
    process.env.VERIF_SALIDA = tmpDir;
    delete process.env.VERIF_EMPRESA;

    // `NOMBRE`/`SALIDA` del módulo bajo prueba se calculan UNA VEZ al
    // importarlo (constantes de módulo leídas de `process.env`/`argv`), así
    // que hay que fijar `VERIF_SALIDA` ANTES de requerirlo — y `resetModules`
    // + `require` dinámico (en vez de un `import` estático de nivel de
    // archivo) es lo que permite reordenar eso desde un `beforeEach`.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ProveedorCredencialesRuntime } = require('../../src/credencialesRuntime');
    borrarSpy = jest.spyOn(ProveedorCredencialesRuntime.prototype, 'borrar');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ejecutarModoPlan = require('../../src/scripts/verificarRespaldoXml').ejecutarModoPlan;
  });

  afterEach(() => {
    delete process.env.VERIF_SALIDA;
    borrarSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('borra la credencial cuando el plan y el cierre de sesión terminan bien', async () => {
    mockCerrarYOlvidar.mockResolvedValue(undefined);

    await ejecutarModoPlan(rutaPlan);

    expect(mockCerrarYOlvidar).toHaveBeenCalledWith('11111111-1', expect.any(Function));
    expect(borrarSpy).toHaveBeenCalledWith('11111111-1');
  });

  // El caso que motivó el arreglo: sin el `finally` anidado, un `cerrarYOlvidar`
  // que lanza se saltea la línea de `credenciales.borrar()` que viene después
  // en el MISMO bloque — acá, si el .pfx de un certificado real se hubiera
  // guardado, quedaría en disco.
  it('borra la credencial aunque registro.cerrarYOlvidar() lance', async () => {
    mockCerrarYOlvidar.mockRejectedValue(new Error('el cierre de sesión del SII falló'));

    await expect(ejecutarModoPlan(rutaPlan)).rejects.toThrow('el cierre de sesión del SII falló');

    expect(borrarSpy).toHaveBeenCalledWith('11111111-1');
  });

  // Si falta VERIF_SALIDA, el chequeo tiene que ganarle a la lectura del
  // plan — si el orden estuviera invertido, este test fallaría con un
  // ENOENT de `fs.readFileSync` (la ruta no existe) en vez del error de
  // VERIF_SALIDA, probando que el plan se leyó (y su aviso de piso, si lo
  // tuviera, se hubiera impreso) para un plan que nunca iba a correr.
  it('chequea VERIF_SALIDA ANTES de leer el archivo del plan', async () => {
    // `SALIDA` es una constante de módulo que se fija al importar — el
    // `beforeEach` de arriba ya requirió el módulo con `VERIF_SALIDA` puesto,
    // así que hay que borrar la variable y volver a requerir ACÁ para que
    // esta corrida vea `SALIDA` realmente ausente.
    delete process.env.VERIF_SALIDA;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ejecutarModoPlanSinSalida = require('../../src/scripts/verificarRespaldoXml').ejecutarModoPlan;
    const rutaQueNoExiste = path.join(tmpDir, 'no-existe.json');

    await expect(ejecutarModoPlanSinSalida(rutaQueNoExiste)).rejects.toThrow('VERIF_SALIDA es obligatorio');
  });

  // Menor: mismo cuarto argumento (la clave del certificado ante el SII) que
  // pasan los otros scripts del repo — sin esto, una consulta que algún día
  // necesite firmar documentos fallaría en silencio sólo en este modo.
  it('pasa SII_CERT_CLAVE_SII como cuarto argumento de guardarCertificado, igual que los demás scripts', async () => {
    mockPerfilConfig.tipo = 'certificado';
    mockCerrarYOlvidar.mockResolvedValue(undefined);
    process.env.SII_CERT_CLAVE_SII = 'clave-sii-del-cert';

    const { ProveedorCredencialesRuntime } = require('../../src/credencialesRuntime');
    const guardarCertificadoSpy = jest.spyOn(ProveedorCredencialesRuntime.prototype, 'guardarCertificado');

    await ejecutarModoPlan(rutaPlan);

    expect(guardarCertificadoSpy).toHaveBeenCalledWith(
      '99999999-9', 'YmFzZTY0', 'clave-pfx', 'clave-sii-del-cert');

    guardarCertificadoSpy.mockRestore();
    delete process.env.SII_CERT_CLAVE_SII;
  });

  // Menor: un plan de N consultas donde algo revienta a mitad de camino no
  // puede perder las mediciones que YA costaron llamadas reales al portal.
  // `recorrerConRitmo` se reemplaza acá para simular exactamente eso —ninguna
  // combinación real de `consultarRespaldoXml`/`ejecutarPlan` puede producir
  // este escenario, las dos capas de try/catch que protegen cada consulta lo
  // impiden— y confirmar que el reporte PARCIAL, con lo que sí se resolvió,
  // queda escrito en disco de todos modos.
  it('escribe el reporte parcial si el plan se interrumpe a mitad de camino, y sigue relanzando el error', async () => {
    mockCerrarYOlvidar.mockResolvedValue(undefined);
    fs.writeFileSync(rutaPlan, JSON.stringify({ consultas: [{}, {}, {}] }), 'utf-8');
    mockRecorrerConRitmo.mockImplementation(
      async (items: unknown[], fn: (item: unknown, i: number) => Promise<unknown>) => {
        await fn(items[0], 0);
        throw new Error('el proceso murió a mitad del plan');
      }
    );

    await expect(ejecutarModoPlan(rutaPlan)).rejects.toThrow('el proceso murió a mitad del plan');

    const reporte = fs.readFileSync(path.join(tmpDir, 'reporte-verificacion-plan.txt'), 'utf-8');
    expect(reporte).toContain('Consulta 1/3');
    expect(reporte).not.toContain('Consulta 2/3');
    expect(reporte).toContain('PARCIAL');
    expect(reporte).toContain('el proceso murió a mitad del plan');
  });
});
