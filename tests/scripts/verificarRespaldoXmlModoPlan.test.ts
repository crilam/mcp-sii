import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Bloqueante: `ejecutarModoPlan` no tenía NINGÚN test — los que hay corren
// contra `ejecutarPlan`, que no abre sesión ni cierra nada. Esta suite cubre
// justo el cierre: `credenciales.borrar()` tiene que correr SIEMPRE, incluso
// cuando `registro.cerrarYOlvidar()` (el cierre de la sesión del SII) lanza,
// porque antes del `finally` anidado un certificado real (perfil por defecto
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

jest.mock('../../src/perfilesVerificacion', () => ({
  perfil: () => ({
    nombre: 'mipyme',
    rut: '11111111-1',
    credencial: { tipo: 'clave', clave: 'clave-test' },
  }),
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

describe('ejecutarModoPlan (la credencial se borra siempre, aunque el cierre de sesión falle)', () => {
  let tmpDir: string;
  let rutaPlan: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let borrarSpy: jest.SpyInstance<any, any>;
  let ejecutarModoPlan: typeof import('../../src/scripts/verificarRespaldoXml').ejecutarModoPlan;

  beforeEach(() => {
    mockCerrarYOlvidar.mockReset();
    mockEjecutar.mockClear();

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
});
