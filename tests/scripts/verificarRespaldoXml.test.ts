import { RegistroSesiones } from '../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../src/credencialesRuntime';
import {
  ejecutarPlan,
  armarReporte,
  normalizarFiltros,
  leerPlan,
  crearEjecutorDeUnaSesion,
  PlanArchivo,
  ScraperRespaldoXml,
  ResultadoPlanItem,
} from '../../src/scripts/verificarRespaldoXml';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

type RespuestaScraper = {
  documentos: number;
  tramos: { fechaDesde: string; fechaHasta: string; documentos: number; xml: string }[];
  limitaciones: { fechaDesde: string; fechaHasta: string; motivo: string; causa?: 'PRESUPUESTO_TRAMOS' | 'OTRA' }[];
};
type FiltrosScraper = Parameters<ScraperRespaldoXml['respaldoXml']>[0];

// Un scraper doble por consulta: la N-ésima llamada a `respaldoXml` devuelve
// la N-ésima respuesta programada (o lanza, si es un Error). Así cada consulta
// del plan puede tener su propio resultado sin decidir por adelantado cuántas
// veces se va a llamar. `llamadas` guarda los filtros CON QUE de verdad se
// llamó al scraper, para poder verificar qué le llegó (por ejemplo
// `maxTramos`) sin adivinarlo del resultado.
function scraperProgramado(
  respuestas: Array<RespuestaScraper | Error>,
  llamadas: FiltrosScraper[] = []
): (sesion: SesionFake) => ScraperRespaldoXml {
  let i = 0;
  return () => ({
    respaldoXml: async filtros => {
      llamadas.push(filtros);
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

  it('un origen inválido en una consulta del plan no aborta las demás, y la consulta inválida NO se rellena con defaults', async () => {
    const { registro } = crearRegistroDoble();
    const crearScraper = scraperProgramado([
      { documentos: 7, tramos: [], limitaciones: [] },
    ]);
    const plan: PlanArchivo = {
      pausa_ms: 0,
      consultas: [{ origen: 'no-existe' }, { origen: 'recibidos' }],
    };

    const resultados = await ejecutarPlan(plan, registro, '11111111-1', crearScraper, undefined);

    expect(resultados[0].resultado.ok).toBe(false);
    expect(resultados[0].resultado.detalle).toMatch(/consultas\[0\]\.origen.*no es válido/);
    // La consulta inválida no se normaliza: no hay `filtros` rellenados con
    // los defaults de una consulta vacía (eso mentiría sobre qué se pidió).
    expect(resultados[0].filtros).toBeUndefined();
    expect(resultados[0].filtrosCrudos).toEqual({ origen: 'no-existe' });
    expect(resultados[1].resultado.ok).toBe(true);

    const reporte = armarReporte(plan, resultados, 1);
    expect(reporte).toContain('INVÁLIDA');
    expect(reporte).toContain('no-existe');
  });

  // Bloqueante de la ronda anterior: la validación tiene que ser la MISMA que
  // la ruta REST rechaza (folio_hasta requiere folio, ver schemas/mipyme.ts),
  // no una más laxa — y el mensaje tiene que decir CUÁL consulta del plan
  // estaba mal escrita.
  it('replica el invariante de la ruta REST folio_hasta-requiere-folio, con el índice de la consulta', async () => {
    const { registro } = crearRegistroDoble();
    const crearScraper = scraperProgramado([{ documentos: 1, tramos: [], limitaciones: [] }]);
    const plan: PlanArchivo = {
      pausa_ms: 0,
      consultas: [{}, { folio_hasta: 500 }],
    };

    const resultados = await ejecutarPlan(plan, registro, '11111111-1', crearScraper, undefined);

    expect(resultados[0].resultado.ok).toBe(true);
    expect(resultados[1].resultado.ok).toBe(false);
    expect(resultados[1].resultado.detalle).toMatch(/consultas\[1\]\.folio_hasta requiere folio/);
  });

  it('propaga max_tramos de la consulta al scraper, y marca en el reporte la que topó el tope leyendo el campo estructurado (NO el texto del motivo)', async () => {
    const { registro } = crearRegistroDoble();
    const llamadas: FiltrosScraper[] = [];
    const crearScraper = scraperProgramado([
      {
        documentos: 20,
        tramos: [{ fechaDesde: '2026-01-01', fechaHasta: '2026-01-15', documentos: 20, xml: '<xml/>' }],
        limitaciones: [{
          fechaDesde: '2026-01-16', fechaHasta: '2026-01-31',
          // Redacción A PROPÓSITO distinta de cualquier plantilla real del
          // scraper (ni "necesita más de N tramos" ni ninguna otra frase
          // conocida): si el test sigue pasando, es porque la marca sale del
          // campo `causa` estructurado, no de adivinar por el texto.
          motivo: 'ranuras de descarga completamente agotadas para este período, probá de nuevo con otro ajuste',
          causa: 'PRESUPUESTO_TRAMOS',
        }],
      },
    ], llamadas);
    const plan: PlanArchivo = { pausa_ms: 0, consultas: [{ max_tramos: 3 }] };

    const resultados = await ejecutarPlan(plan, registro, '11111111-1', crearScraper, undefined);

    expect(llamadas[0].maxTramos).toBe(3);
    expect(resultados[0].resultado.ok).toBe(true);
    expect(resultados[0].resultado.topoLimiteTramos).toBe(true);

    const reporte = armarReporte(plan, resultados, 1);
    expect(reporte).toContain('TOPÓ max_tramos');
    expect(reporte).toContain('NO comparable');
    expect(reporte).toContain('max_tramos=3');
  });

  // La otra mitad de la prueba anterior: una limitación que SÍ usa la
  // plantilla de texto vieja ("necesita más de N tramos") pero sin `causa`
  // NO se marca como tope — si la detección todavía mirara el texto, esta
  // aserción fallaría. Sin el campo estructurado no hay forma honesta de
  // saber si es un corte por presupuesto o alguna otra limitación que por
  // casualidad comparte palabras.
  it('NO marca como tope una limitación con la vieja frase "necesita más de N tramos" si no trae `causa`', async () => {
    const { registro } = crearRegistroDoble();
    const crearScraper = scraperProgramado([
      {
        documentos: 20,
        tramos: [{ fechaDesde: '2026-01-01', fechaHasta: '2026-01-15', documentos: 20, xml: '<xml/>' }],
        limitaciones: [{
          fechaDesde: '2026-01-16', fechaHasta: '2026-01-31',
          motivo: 'El respaldo de 11111111-1 necesita más de 3 tramos para respetar el tope de 20 documentos.',
          // Sin `causa`: a propósito, para separar "el texto lo dice" de
          // "el campo lo dice".
        }],
      },
    ]);
    const plan: PlanArchivo = { pausa_ms: 0, consultas: [{ max_tramos: 3 }] };

    const resultados = await ejecutarPlan(plan, registro, '11111111-1', crearScraper, undefined);

    expect(resultados[0].resultado.topoLimiteTramos).toBe(false);
    const reporte = armarReporte(plan, resultados, 1);
    expect(reporte).not.toContain('TOPÓ max_tramos');
  });

  it('describirFiltros muestra rzn_soc en el reporte (dos consultas que sólo difieren en razón social no se leen igual)', async () => {
    const { registro } = crearRegistroDoble();
    const crearScraper = scraperProgramado([{ documentos: 0, tramos: [], limitaciones: [] }]);
    const plan: PlanArchivo = { pausa_ms: 0, consultas: [{ contraparte: '77777777-7', rzn_soc: 'Panadería de Prueba' }] };

    const resultados = await ejecutarPlan(plan, registro, '11111111-1', crearScraper, undefined);
    const reporte = armarReporte(plan, resultados, 1);

    expect(reporte).toContain('Panadería de Prueba');
  });
});

describe('leerPlan (caminos de error del parser de entrada)', () => {
  function archivoTemporal(contenido: string): string {
    const destino = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-')), 'plan.json');
    fs.writeFileSync(destino, contenido, 'utf-8');
    return destino;
  }

  it('rechaza un archivo que no es JSON válido', () => {
    const ruta = archivoTemporal('{ esto no es json');
    expect(() => leerPlan(ruta)).toThrow(/no es JSON válido/);
  });

  it('rechaza un plan sin el array "consultas"', () => {
    const ruta = archivoTemporal(JSON.stringify({ pausa_ms: 100 }));
    expect(() => leerPlan(ruta)).toThrow(/tiene que traer un array "consultas"/);
  });

  it('rechaza un plan con "consultas" vacío', () => {
    const ruta = archivoTemporal(JSON.stringify({ consultas: [] }));
    expect(() => leerPlan(ruta)).toThrow(/al menos un elemento/);
  });

  it('acepta un plan válido y default la pausa a undefined si no viene', () => {
    const ruta = archivoTemporal(JSON.stringify({ consultas: [{ origen: 'recibidos' }] }));
    const plan = leerPlan(ruta);
    expect(plan.consultas).toHaveLength(1);
    expect(plan.pausa_ms).toBeUndefined();
  });
});

describe('armarReporte (comparación y contaminación visible)', () => {
  it('el conteo de logins aparece en la salida, con aviso explícito si hubo más de uno', () => {
    const plan: PlanArchivo = { consultas: [{}] };
    const resultados: ResultadoPlanItem[] = [
      {
        indice: 0,
        filtrosCrudos: {},
        filtros: normalizarFiltros({}, 'x'),
        resultado: { ok: true, documentos: 0, tramos: [] },
      },
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
