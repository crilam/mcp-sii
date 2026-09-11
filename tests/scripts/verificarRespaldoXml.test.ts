import { RegistroSesiones } from '../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../src/credencialesRuntime';
import {
  ejecutarPlan,
  armarReporte,
  normalizarFiltros,
  crearEjecutorDeUnaSesion,
  PlanArchivo,
  ScraperRespaldoXml,
  ResultadoPlanItem,
} from '../../src/scripts/verificarRespaldoXml';

// El bug que esta suite cierra: cada corrida de este script armaba un
// `Browser` nuevo (login nuevo al SII), así que "verificar varias
// combinaciones de filtros" terminaba siendo "encadenar N logins" — el
// patrón que el SII bloquea por sesiones simultáneas, y que una vez dio
// resultados DISTINTOS (3 documentos contra 7) para el mismo mes y el mismo
// tipo de documento, sin ninguna página de error. El modo plan tiene que
// correr TODAS sus consultas contra la MISMA sesión.

interface SesionFake { numero: number }

// Doble MÍNIMO de una sesión: no es un SessionManager real (no hace falta
// para probar el reuso — eso ya lo prueba tests/registroSesiones.test.ts para
// RegistroSesiones en general), sólo algo que se pueda contar por instancia.
function crearRegistroDoble(): { registro: RegistroSesiones<SesionFake>; construcciones: () => number } {
  let contador = 0;
  const registro = new RegistroSesiones<SesionFake>(async () => ({ numero: ++contador }));
  return { registro, construcciones: () => contador };
}

type RespuestaScraper = { documentos: number; tramos: { fechaDesde: string; fechaHasta: string; documentos: number; xml: string }[]; limitaciones: { fechaDesde: string; fechaHasta: string; motivo: string }[] };

// Un scraper doble por consulta: la N-ésima llamada a `respaldoXml` devuelve
// la N-ésima respuesta programada (o lanza, si es un Error). Así cada consulta
// del plan puede tener su propio resultado sin decidir por adelantado cuántas
// veces se va a llamar.
function scraperProgramado(respuestas: Array<RespuestaScraper | Error>): (sesion: SesionFake) => ScraperRespaldoXml {
  let i = 0;
  return () => ({
    respaldoXml: async () => {
      const r = respuestas[i++];
      if (r instanceof Error) throw r;
      return r;
    },
  });
}

describe('ejecutarPlan (modo plan: varias consultas, una sola sesión)', () => {
  it('un plan de tres consultas usa UNA sola sesión', async () => {
    const { registro, construcciones } = crearRegistroDoble();
    const crearScraper = scraperProgramado([
      { documentos: 1, tramos: [{ fechaDesde: '2026-01-01', fechaHasta: '2026-01-10', documentos: 1, xml: '<xml/>' }], limitaciones: [] },
      { documentos: 2, tramos: [{ fechaDesde: '2026-01-11', fechaHasta: '2026-01-20', documentos: 2, xml: '<xml/>' }], limitaciones: [] },
      { documentos: 3, tramos: [{ fechaDesde: '2026-01-21', fechaHasta: '2026-01-31', documentos: 3, xml: '<xml/>' }], limitaciones: [] },
    ]);
    const plan: PlanArchivo = {
      pausa_ms: 0,
      consultas: [
        { desde: '2026-01-01', hasta: '2026-01-10' },
        { desde: '2026-01-11', hasta: '2026-01-20' },
        { desde: '2026-01-21', hasta: '2026-01-31' },
      ],
    };

    const resultados = await ejecutarPlan(plan, registro, '11111111-1', crearScraper, undefined);

    expect(resultados).toHaveLength(3);
    expect(resultados.map(r => r.resultado.documentos)).toEqual([1, 2, 3]);
    // El punto entero de la tarea: TRES consultas, UNA sola sesión construida.
    expect(construcciones()).toBe(1);
  });

  it('una consulta del plan que falla no aborta las siguientes, y su fallo queda en la salida', async () => {
    const { registro } = crearRegistroDoble();
    const crearScraper = scraperProgramado([
      { documentos: 1, tramos: [{ fechaDesde: '2026-01-01', fechaHasta: '2026-01-10', documentos: 1, xml: '<xml/>' }], limitaciones: [] },
      new Error('el SII devolvió una página de error'),
      { documentos: 3, tramos: [{ fechaDesde: '2026-01-21', fechaHasta: '2026-01-31', documentos: 3, xml: '<xml/>' }], limitaciones: [] },
    ]);
    const plan: PlanArchivo = { pausa_ms: 0, consultas: [{}, {}, {}] };

    const resultados = await ejecutarPlan(plan, registro, '11111111-1', crearScraper, undefined);

    expect(resultados).toHaveLength(3);
    expect(resultados[0].resultado.ok).toBe(true);
    expect(resultados[1].resultado.ok).toBe(false);
    expect(resultados[1].resultado.detalle).toContain('página de error');
    // La TERCERA consulta corrió igual, aunque la segunda haya fallado.
    expect(resultados[2].resultado.ok).toBe(true);
    expect(resultados[2].resultado.documentos).toBe(3);

    const reporte = armarReporte(plan, resultados, 1);
    expect(reporte).toContain('FALLA');
    expect(reporte).toContain('página de error');
    // Las tres consultas están en el reporte, en el orden en que corrieron.
    expect(reporte.indexOf('Consulta 1/3')).toBeLessThan(reporte.indexOf('Consulta 2/3'));
    expect(reporte.indexOf('Consulta 2/3')).toBeLessThan(reporte.indexOf('Consulta 3/3'));
  });

  it('un origen inválido en una consulta del plan no aborta las demás', async () => {
    const { registro } = crearRegistroDoble();
    const crearScraper = scraperProgramado([
      { documentos: 5, tramos: [], limitaciones: [] },
      { documentos: 7, tramos: [], limitaciones: [] },
    ]);
    const plan: PlanArchivo = {
      pausa_ms: 0,
      consultas: [{ origen: 'no-existe' }, { origen: 'recibidos' }],
    };

    const resultados = await ejecutarPlan(plan, registro, '11111111-1', crearScraper, undefined);

    expect(resultados[0].resultado.ok).toBe(false);
    expect(resultados[0].resultado.detalle).toMatch(/no es válido/);
    expect(resultados[1].resultado.ok).toBe(true);
  });
});

describe('armarReporte (comparación y contaminación visible)', () => {
  it('el conteo de logins aparece en la salida, con aviso explícito si hubo más de uno', () => {
    const plan: PlanArchivo = { consultas: [{}] };
    const resultados: ResultadoPlanItem[] = [
      { indice: 0, filtros: normalizarFiltros({}, 'x'), resultado: { ok: true, documentos: 0, tramos: [] } },
    ];

    const unaSola = armarReporte(plan, resultados, 1);
    expect(unaSola).toContain('Logins al SII en esta corrida: 1');
    expect(unaSola).not.toContain('ATENCIÓN');

    const varias = armarReporte(plan, resultados, 3);
    expect(varias).toContain('ATENCIÓN: esta corrida hizo 3 LOGINS al SII');
    expect(varias).toContain('NO es comparable consigo misma');
  });
});

describe('crearEjecutorDeUnaSesion (conteo de logins = construcciones de Browser)', () => {
  it('cuenta un solo login aunque el RUT se use varias veces', async () => {
    const credenciales = new ProveedorCredencialesRuntime();
    credenciales.guardar('11111111-1', 'clave-test');
    const { registro, contarLogins } = crearEjecutorDeUnaSesion(credenciales);

    expect(contarLogins()).toBe(0);
    await registro.ejecutar('11111111-1', async s => s);
    expect(contarLogins()).toBe(1);
    await registro.ejecutar('11111111-1', async s => s);
    // Reuso: la segunda llamada no abre otro contexto de navegador.
    expect(contarLogins()).toBe(1);
  });
});
