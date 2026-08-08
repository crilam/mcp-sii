/**
 * IMPORTANTE: todos los valores de parámetros de este archivo son INVENTADOS y
 * redondos, elegidos para que los resultados esperados puedan calcularse a mano.
 *
 * No son las tasas ni los tramos vigentes en Chile, y no deben copiarse a
 * producción. Lo que estas pruebas verifican es la **secuencia del cálculo** y
 * que el motor se niegue a operar sin parámetros — no los valores.
 */
import {
  type Trabajador,
  liquidar,
  parametrosRequeridos,
} from '../src/remuneraciones/liquidacion';
import { ParametrosInconsistentes, TablaDeParametros } from '../src/parametros/tabla';
import { TablaDeTramos, TramosFaltantes, TramosInconsistentes } from '../src/parametros/tramos';

const PERIODO = '202601';

const VALORES_INVENTADOS: Record<string, number> = {
  'previsional.uf.valor': 40_000,
  'previsional.utm.valor': 70_000,
  'previsional.tope_imponible_afp_uf': 90,
  'previsional.tope_imponible_salud_uf': 80,
  'previsional.tope_imponible_cesantia_uf': 130,
  'previsional.afp.ejemplo.tasa': 0.11,
  'previsional.salud.tasa_legal': 0.07,
  'previsional.sis.tasa': 0.015,
  'previsional.mutual.tasa': 0.0093,
  'previsional.cesantia.trabajador.indefinido': 0.006,
  'previsional.cesantia.empleador.indefinido': 0.024,
  'previsional.cesantia.empleador.plazo_fijo': 0.03,
};

function parametros(omitir: readonly string[] = []): TablaDeParametros {
  return TablaDeParametros.desde(
    Object.entries(VALORES_INVENTADOS)
      .filter(([nombre]) => !omitir.includes(nombre))
      .map(([nombre, valor]) => ({
        nombre,
        descripcion: `valor inventado para pruebas: ${nombre}`,
        unidad: 'cantidad' as const,
        valores: [{ desde: '202601', hasta: null, valor, fuente: 'inventado para pruebas' }],
      })),
  );
}

/** Tramos inventados, en UTM. */
const TRAMOS = TablaDeTramos.desde('impuesto_unico_segunda_categoria', [
  {
    desde: '202601',
    hasta: null,
    unidad: 'utm',
    fuente: 'inventado para pruebas',
    tramos: [
      { desde: 0, hasta: 13.5, factor: 0, rebaja: 0 },
      { desde: 13.5, hasta: 30, factor: 0.04, rebaja: 0.54 },
      { desde: 30, hasta: null, factor: 0.08, rebaja: 1.74 },
    ],
  },
]);

const TRABAJADOR: Trabajador = {
  id: 'trabajador-1',
  afpCodigo: 'ejemplo',
  sistemaSalud: 'fonasa',
  tipoContrato: 'indefinido',
};

function haberes(sueldoBase: number, noImponibles = 0) {
  return { sueldoBase, gratificacion: 0, horasExtra: 0, otrosImponibles: 0, noImponibles };
}

function liquidacionDe(sueldoBase: number, noImponibles = 0, trabajador = TRABAJADOR) {
  return liquidar({
    trabajador,
    periodo: PERIODO,
    haberes: haberes(sueldoBase, noImponibles),
    parametros: parametros(),
    tramosImpuestoUnico: TRAMOS,
  });
}

describe('liquidación sin impuesto único', () => {
  // Sueldo 1.000.000 + colación 100.000.
  // AFP 110.000, salud 70.000, cesantía 6.000 = 186.000.
  // Base tributable 814.000, que en UTM son 11,63: cae en el tramo exento.
  const l = liquidacionDe(1_000_000, 100_000);

  it('separa imponible de no imponible', () => {
    expect(l.totalImponible).toBe(1_000_000);
    expect(l.totalNoImponible).toBe(100_000);
    expect(l.totalHaberes).toBe(1_100_000);
  });

  it('calcula las tres cotizaciones del trabajador', () => {
    expect(l.cotizaciones.map((c) => c.monto)).toEqual([110_000, 70_000, 6_000]);
    expect(l.totalCotizacionesTrabajador).toBe(186_000);
  });

  it('calcula el impuesto sobre lo imponible menos cotizaciones, no sobre el bruto', () => {
    expect(l.baseTributable).toBe(814_000);
    expect(l.impuestoUnico).toBe(0);
  });

  it('no descuenta lo no imponible de la base tributable ni de las cotizaciones', () => {
    // La colación no cotiza ni tributa, pero sí se paga.
    expect(l.cotizaciones[0]?.base).toBe(1_000_000);
    expect(l.liquidoAPagar).toBe(914_000);
  });

  it('deja el nombre del parámetro de cada tasa, para poder auditarla', () => {
    expect(l.cotizaciones[0]?.parametro).toBe('previsional.afp.ejemplo.tasa');
  });
});

describe('liquidación con impuesto único', () => {
  // Sueldo 2.000.000. Cotizaciones 372.000. Base 1.628.000 = 23,26 UTM.
  // Tramo 2: 1.628.000 × 0,04 − 0,54 UTM (37.800) = 27.320.
  const l = liquidacionDe(2_000_000);

  it('aplica el tramo con su rebaja', () => {
    expect(l.baseTributable).toBe(1_628_000);
    expect(l.impuestoUnico).toBe(27_320);
  });

  it('descuenta cotizaciones e impuesto del líquido', () => {
    expect(l.totalDescuentos).toBe(399_320);
    expect(l.liquidoAPagar).toBe(1_600_680);
  });

  it('calcula el costo del empleador por encima del bruto', () => {
    // SIS 30.000 + mutual 18.600 + cesantía empleador 48.000 = 96.600.
    expect(l.aportesDelEmpleador.map((a) => a.monto)).toEqual([30_000, 18_600, 48_000]);
    expect(l.costoEmpleador).toBe(2_096_600);
  });
});

describe('topes imponibles', () => {
  // Sueldo 5.000.000 contra topes de 90, 80 y 130 UF a 40.000 la UF.
  const l = liquidacionDe(5_000_000);

  it('tope cada cotización con su propio tope, que son distintos', () => {
    expect(l.topeImponibleAfp).toBe(3_600_000);
    expect(l.cotizaciones[0]?.monto).toBe(396_000); // 3.600.000 × 11 %
    expect(l.cotizaciones[1]?.monto).toBe(224_000); // 3.200.000 × 7 %
    expect(l.cotizaciones[2]?.monto).toBe(30_000); // 5.000.000 × 0,6 %, bajo el tope
  });

  it('no topea el imponible total ni el líquido', () => {
    expect(l.totalImponible).toBe(5_000_000);
  });
});

describe('salud en isapre', () => {
  const conPlan: Trabajador = { ...TRABAJADOR, sistemaSalud: 'isapre', planSaludUf: 3 };

  it('cotiza el plan cuando supera al mínimo legal', () => {
    // Plan 3 UF = 120.000 contra legal 70.000.
    const l = liquidacionDe(1_000_000, 0, conPlan);
    expect(l.cotizaciones[1]?.monto).toBe(120_000);
    expect(l.cotizaciones[1]?.concepto).toBe('Salud (plan isapre)');
  });

  it('cotiza el mínimo legal cuando el plan es menor', () => {
    // El plan es un piso contractual, no un reemplazo del mínimo legal.
    const planChico: Trabajador = { ...conPlan, planSaludUf: 1 };
    const l = liquidacionDe(1_000_000, 0, planChico);
    expect(l.cotizaciones[1]?.monto).toBe(70_000);
  });
});

describe('contrato a plazo fijo', () => {
  const plazoFijo: Trabajador = { ...TRABAJADOR, tipoContrato: 'plazo_fijo' };

  it('no descuenta cesantía al trabajador', () => {
    const l = liquidacionDe(1_000_000, 0, plazoFijo);
    expect(l.cotizaciones).toHaveLength(2);
    expect(l.totalCotizacionesTrabajador).toBe(180_000);
  });

  it('cobra al empleador la tasa de plazo fijo, que es otra', () => {
    const l = liquidacionDe(1_000_000, 0, plazoFijo);
    expect(l.aportesDelEmpleador[2]?.monto).toBe(30_000); // 3 % en vez de 2,4 %
  });

  it('pide otros parámetros que el contrato indefinido', () => {
    expect(parametrosRequeridos(plazoFijo)).toContain('previsional.cesantia.empleador.plazo_fijo');
    expect(parametrosRequeridos(plazoFijo)).not.toContain('previsional.cesantia.trabajador.indefinido');
  });
});

describe('el motor se niega a liquidar sin parámetros', () => {
  it('falla nombrando el parámetro faltante', () => {
    expect(() =>
      liquidar({
        trabajador: TRABAJADOR,
        periodo: PERIODO,
        haberes: haberes(1_000_000),
        parametros: parametros(['previsional.afp.ejemplo.tasa']),
        tramosImpuestoUnico: TRAMOS,
      }),
    ).toThrow(/previsional\.afp\.ejemplo\.tasa/);
  });

  it('nombra todos los faltantes juntos, no el primero', () => {
    try {
      liquidar({
        trabajador: TRABAJADOR,
        periodo: PERIODO,
        haberes: haberes(1_000_000),
        parametros: parametros(['previsional.uf.valor', 'previsional.utm.valor']),
        tramosImpuestoUnico: TRAMOS,
      });
      throw new Error('debió lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(ParametrosInconsistentes);
      expect((error as ParametrosInconsistentes).message).toMatch(/previsional\.uf\.valor/);
      expect((error as ParametrosInconsistentes).message).toMatch(/previsional\.utm\.valor/);
    }
  });

  it('no usa los parámetros de otro período', () => {
    // Es la regla del proyecto: aplicar la tasa del año pasado produce una
    // liquidación que se ve razonable y está mal.
    expect(() =>
      liquidar({
        trabajador: TRABAJADOR,
        periodo: '202512',
        haberes: haberes(1_000_000),
        parametros: parametros(),
        tramosImpuestoUnico: TRAMOS,
      }),
    ).toThrow(ParametrosInconsistentes);
  });

  it('falla si no hay tabla de tramos vigente para el período', () => {
    const tramosViejos = TablaDeTramos.desde('impuesto_unico', [
      {
        desde: '202001',
        hasta: '202012',
        unidad: 'utm',
        fuente: 'inventado',
        tramos: [{ desde: 0, hasta: null, factor: 0, rebaja: 0 }],
      },
    ]);

    expect(() =>
      liquidar({
        trabajador: TRABAJADOR,
        periodo: PERIODO,
        haberes: haberes(1_000_000),
        parametros: parametros(),
        tramosImpuestoUnico: tramosViejos,
      }),
    ).toThrow(TramosFaltantes);
  });
});

describe('validación de la tabla de tramos', () => {
  function conTramos(tramos: { desde: number; hasta: number | null; factor: number; rebaja: number }[]) {
    return () =>
      TablaDeTramos.desde('prueba', [
        { desde: '202601', hasta: null, unidad: 'utm', fuente: 'x', tramos },
      ]);
  }

  it('rechaza un hueco al principio, que dejaría rentas bajas sin tramo', () => {
    expect(conTramos([{ desde: 10, hasta: null, factor: 0, rebaja: 0 }])).toThrow(/no en 0/);
  });

  it('rechaza un tramo superior cerrado, que dejaría rentas altas sin tramo', () => {
    expect(conTramos([{ desde: 0, hasta: 100, factor: 0, rebaja: 0 }])).toThrow(/tiene que ser abierto/);
  });

  it('rechaza tramos que se solapan', () => {
    expect(
      conTramos([
        { desde: 0, hasta: 20, factor: 0, rebaja: 0 },
        { desde: 15, hasta: null, factor: 0.04, rebaja: 0.5 },
      ]),
    ).toThrow(/se solapan/);
  });

  it('detecta un factor expresado en porcentaje en vez de fracción', () => {
    // 4 en vez de 0,04 multiplicaría el impuesto por cien.
    expect(
      conTramos([
        { desde: 0, hasta: 20, factor: 4, rebaja: 0 },
        { desde: 20, hasta: null, factor: 0.08, rebaja: 1 },
      ]),
    ).toThrow(TramosInconsistentes);
  });

  it('da exactamente cero en el punto donde la rebaja iguala al producto', () => {
    expect(TRAMOS.aplicar(13.5, PERIODO).impuesto).toBe(0);
  });

  it('nunca devuelve impuesto negativo cuando la rebaja supera al producto', () => {
    // Un impuesto negativo se restaría de los descuentos y aumentaría el
    // líquido: el trabajador cobraría de más y nadie lo notaría.
    const conRebajaExcesiva = TablaDeTramos.desde('prueba', [
      {
        desde: '202601',
        hasta: null,
        unidad: 'utm',
        fuente: 'inventado',
        tramos: [{ desde: 0, hasta: null, factor: 0.04, rebaja: 5 }],
      },
    ]);
    expect(conRebajaExcesiva.aplicar(10, PERIODO).impuesto).toBe(0);
  });

  it('el borde de un tramo cae en uno solo, no en dos', () => {
    // `hasta` es exclusivo: 13,5 pertenece al segundo tramo, no al primero.
    expect(TRAMOS.aplicar(13.5, PERIODO).tramo.desde).toBe(13.5);
    expect(TRAMOS.aplicar(13.49, PERIODO).tramo.desde).toBe(0);
  });
});
