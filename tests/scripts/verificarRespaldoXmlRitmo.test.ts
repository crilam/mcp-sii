import { RegistroSesiones } from '../../src/registroSesiones';

// Este archivo mockea `ritmoSii` ENTERO (no sólo `esperar`), a propósito: la
// pausa entre consultas la implementa `recorrerConRitmo` recorriendo su
// propio arreglo y llamando a su `esperar` INTERNO — un mock parcial que sólo
// reemplace el `esperar` exportado no lo intercepta (`recorrerConRitmo` no
// pasa por `require()` para llamarse a sí mismo). Por eso la aserción va
// contra el DOBLE de `recorrerConRitmo` completo: qué pausa le pide el modo
// plan, no el reloj real. El comportamiento de la pausa en sí —que de verdad
// espere entre llamadas— ya lo cubre tests/ritmoSii.test.ts.
// `PAUSA_POR_DEFECTO_MS` viaja con `jest.requireActual` (el valor REAL, no
// uno escrito a mano acá) porque `ejecutarPlan` la importa para aplicar su
// propio piso de defensa: un mock parcial sin esta constante la deja
// `undefined` y el piso calcula `NaN`. Escribirla a mano en el mock es
// justo lo que exportar la constante vino a evitar — si el piso cambia algún
// día, esta prueba tiene que enterarse sola, no seguir pasando con el valor
// viejo.
jest.mock('../../src/ritmoSii', () => ({
  ...jest.requireActual('../../src/ritmoSii'),
  recorrerConRitmo: jest.fn(),
}));

import { recorrerConRitmo, PAUSA_POR_DEFECTO_MS } from '../../src/ritmoSii';
import { ejecutarPlan, PlanArchivo, ScraperRespaldoXml } from '../../src/scripts/verificarRespaldoXml';

const mockRecorrer = recorrerConRitmo as jest.MockedFunction<typeof recorrerConRitmo>;

function crearScraperVacio() {
  return () => ({ respaldoXml: async () => ({ documentos: 0, tramos: [], limitaciones: [] }) } as ScraperRespaldoXml);
}

describe('ejecutarPlan respeta el ritmo entre consultas (vía recorrerConRitmo)', () => {
  beforeEach(() => { mockRecorrer.mockReset(); });

  it('delega el recorrido en recorrerConRitmo con la pausa que trae el plan', async () => {
    mockRecorrer.mockImplementation(async (items, fn) => {
      const salida = [];
      for (const [i, item] of (items as unknown[]).entries()) salida.push(await (fn as (item: unknown, i: number) => Promise<unknown>)(item, i));
      return salida;
    });
    const registro = new RegistroSesiones<{ n: number }>(async () => ({ n: 1 }));
    const plan: PlanArchivo = { pausa_ms: 5000, consultas: [{}, {}] };

    await ejecutarPlan(plan, registro, '11111111-1', crearScraperVacio(), undefined);

    expect(mockRecorrer).toHaveBeenCalledTimes(1);
    expect(mockRecorrer.mock.calls[0][2]).toEqual({ pausaMs: 5000 });
  });

  it('sin pausa propia en el plan, NO inventa una pausa: deja que recorrerConRitmo aplique su piso', async () => {
    mockRecorrer.mockResolvedValue([]);
    const registro = new RegistroSesiones<{ n: number }>(async () => ({ n: 1 }));
    const plan: PlanArchivo = { consultas: [{}] };

    await ejecutarPlan(plan, registro, '11111111-1', crearScraperVacio(), undefined);

    expect(mockRecorrer.mock.calls[0][2]).toEqual({ pausaMs: undefined });
  });

  // Bloqueante: `recorrerConRitmo` sólo aplica su piso cuando `pausaMs` es
  // `undefined` — un `pausaMs` explícito, aunque sea 0, lo pisa por diseño.
  // `leerPlan` ya sube `pausa_ms` al piso al leer el archivo, pero
  // `ejecutarPlan` lo vuelve a exigir por si alguien arma un `PlanArchivo` a
  // mano (sin pasar por `leerPlan`) con una pausa baja.
  it('sube pausa_ms al piso aunque el PlanArchivo lo traiga por debajo (defensa, no sólo leerPlan)', async () => {
    mockRecorrer.mockResolvedValue([]);
    const registro = new RegistroSesiones<{ n: number }>(async () => ({ n: 1 }));
    const plan: PlanArchivo = { pausa_ms: 5, consultas: [{}] };

    await ejecutarPlan(plan, registro, '11111111-1', crearScraperVacio(), undefined);

    expect(mockRecorrer.mock.calls[0][2]).toEqual({ pausaMs: PAUSA_POR_DEFECTO_MS });
  });

  // La única vía para saltarse el piso: el parámetro de prueba explícito, que
  // NO es parte de `PlanArchivo`/`leerPlan` y por eso no puede colarse desde
  // un archivo real.
  it('opcionesDePrueba.pausaMsSinPiso es la única forma de bajar del piso, y sólo la usan los tests', async () => {
    mockRecorrer.mockResolvedValue([]);
    const registro = new RegistroSesiones<{ n: number }>(async () => ({ n: 1 }));
    const plan: PlanArchivo = { pausa_ms: 5000, consultas: [{}] };

    await ejecutarPlan(plan, registro, '11111111-1', crearScraperVacio(), undefined, { pausaMsSinPiso: 0 });

    expect(mockRecorrer.mock.calls[0][2]).toEqual({ pausaMs: 0 });
  });
});
