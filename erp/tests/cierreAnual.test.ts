/**
 * Puente entre remuneraciones y el mayor, y determinación de RLI.
 *
 * Los montos de la nómina salen de una liquidación construida con parámetros
 * inventados (ver `remuneraciones.test.ts`): lo que se verifica acá es que el
 * asiento cuadre y esté imputado donde corresponde, no las tasas.
 */
import {
  CuentasDeRemuneracionesFaltantes,
  contabilizarNomina,
  cuentasQueFaltan,
  retencionesDelPeriodo,
} from '../src/remuneraciones/asiento';
import { type Liquidacion } from '../src/remuneraciones/liquidacion';
import { CuentasSinClasificar, cuentasSinClasificar, determinarRli } from '../src/renta/rli';
import { totalDebe, totalHaber } from '../src/dominio/asiento';
import { asientosDeEnero, plan } from './fixtures';

const EMPRESA = '11111111-1';

const CUENTAS = {
  gastoRemuneraciones: '5102',
  gastoAportesEmpleador: '5103',
  cotizacionesPorPagar: '2103',
  retencionImpuestoUnico: '2104',
  liquidosPorPagar: '2105',
};

/** Liquidación con cifras redondas, para poder verificar el asiento a mano. */
function liquidacion(parcial: Partial<Liquidacion> = {}): Liquidacion {
  return {
    trabajadorId: 'trabajador-1',
    periodo: '202601',
    totalImponible: 1_000_000,
    totalNoImponible: 0,
    totalHaberes: 1_000_000,
    topeImponibleAfp: 3_600_000,
    imponibleTopadoAfp: 1_000_000,
    cotizaciones: [],
    totalCotizacionesTrabajador: 186_000,
    baseTributable: 814_000,
    baseTributableUtm: 11.63,
    impuestoUnico: 0,
    totalDescuentos: 186_000,
    liquidoAPagar: 814_000,
    aportesDelEmpleador: [
      { concepto: 'SIS', base: 1_000_000, tasa: 0.015, monto: 15_000, parametro: 'previsional.sis.tasa' },
    ],
    costoEmpleador: 1_015_000,
    ...parcial,
  };
}

describe('nómina contabilizada', () => {
  const asiento = contabilizarNomina([liquidacion()], CUENTAS, 'b-1', EMPRESA, '2026-01-31');

  it('cuadra', () => {
    expect(totalDebe(asiento.lineas)).toBe(totalHaber(asiento.lineas));
    // Bruto 1.000.000 + aportes 15.000.
    expect(totalDebe(asiento.lineas)).toBe(1_015_000);
  });

  it('separa el gasto del bruto del gasto de los aportes del empleador', () => {
    const porCuenta = new Map(asiento.lineas.map((l) => [l.cuentaCodigo, l]));
    expect(porCuenta.get('5102')?.debe).toBe(1_000_000);
    expect(porCuenta.get('5103')?.debe).toBe(15_000);
  });

  it('junta en el pasivo lo retenido al trabajador y lo aportado por el empleador', () => {
    // Se enteran juntas en la misma planilla.
    const porCuenta = new Map(asiento.lineas.map((l) => [l.cuentaCodigo, l]));
    expect(porCuenta.get('2103')?.haber).toBe(201_000); // 186.000 + 15.000
    expect(porCuenta.get('2105')?.haber).toBe(814_000);
  });

  it('omite la retención cuando no hubo impuesto, en vez de dejar una línea en cero', () => {
    expect(asiento.lineas.map((l) => l.cuentaCodigo)).not.toContain('2104');
  });

  it('agrega la retención cuando sí hubo impuesto', () => {
    const conImpuesto = contabilizarNomina(
      [liquidacion({ impuestoUnico: 27_320, liquidoAPagar: 786_680, totalDescuentos: 213_320 })],
      CUENTAS,
      'b-2',
      EMPRESA,
      '2026-01-31',
    );
    const porCuenta = new Map(conImpuesto.lineas.map((l) => [l.cuentaCodigo, l]));
    expect(porCuenta.get('2104')?.haber).toBe(27_320);
    expect(totalDebe(conImpuesto.lineas)).toBe(totalHaber(conImpuesto.lineas));
  });

  it('agrupa varias liquidaciones en un solo asiento', () => {
    // Un asiento por trabajador llenaría el libro diario de asientos idénticos
    // en estructura; el detalle por persona vive en la liquidación.
    const nomina = contabilizarNomina(
      [liquidacion(), liquidacion({ trabajadorId: 'trabajador-2' })],
      CUENTAS,
      'b-3',
      EMPRESA,
      '2026-01-31',
    );
    expect(totalDebe(nomina.lineas)).toBe(2_030_000);
    expect(nomina.glosa).toContain('2 liquidación(es)');
  });

  it('rechaza mezclar períodos en un asiento', () => {
    expect(() =>
      contabilizarNomina(
        [liquidacion(), liquidacion({ periodo: '202602' })],
        CUENTAS,
        'b-4',
        EMPRESA,
        '2026-01-31',
      ),
    ).toThrow(/más de un período/);
  });

  it('se niega a imputar sin las cuentas configuradas', () => {
    // Elegirlas por nombre parecido produciría un asiento que cuadra y está
    // mal imputado, y el balance no lo delata.
    const { gastoRemuneraciones, ...incompletas } = CUENTAS;
    expect(gastoRemuneraciones).toBeDefined();
    expect(() => contabilizarNomina([liquidacion()], incompletas, 'b-5', EMPRESA, '2026-01-31')).toThrow(
      CuentasDeRemuneracionesFaltantes,
    );
    expect(cuentasQueFaltan(incompletas)).toEqual(['gastoRemuneraciones']);
  });

  it('suma las retenciones del período para la declaración mensual', () => {
    expect(retencionesDelPeriodo([liquidacion({ impuestoUnico: 10_000 }), liquidacion()])).toBe(10_000);
  });
});

describe('renta líquida imponible', () => {
  // Enero de las fixtures: ingresos 100.000, gastos 850.000, resultado −750.000.
  const RANGO = { desde: '2026-01-01', hasta: '2026-01-31' };
  const asientos = asientosDeEnero();

  const todasAceptadas = [
    { cuentaCodigo: '4101', clasificacion: 'aceptado' as const, fundamento: 'ingreso del giro' },
    { cuentaCodigo: '5101', clasificacion: 'aceptado' as const, fundamento: 'costo del giro' },
    { cuentaCodigo: '5102', clasificacion: 'aceptado' as const, fundamento: 'remuneraciones' },
  ];

  it('parte del resultado contable cuando no hay ajustes', () => {
    const rli = determinarRli(EMPRESA, asientos, plan(), todasAceptadas, RANGO);
    expect(rli.resultadoContable).toBe(-750_000);
    expect(rli.rentaLiquidaImponible).toBe(-750_000);
  });

  it('agrega los gastos rechazados de vuelta', () => {
    const conRechazado = todasAceptadas.map((c) =>
      c.cuentaCodigo === '5102'
        ? { ...c, clasificacion: 'gasto_rechazado' as const, fundamento: 'no acreditado' }
        : c,
    );
    const rli = determinarRli(EMPRESA, asientos, plan(), conRechazado, RANGO);

    expect(rli.totalAgregados).toBe(800_000);
    expect(rli.rentaLiquidaImponible).toBe(50_000);
    expect(rli.agregados[0]?.fundamento).toBe('no acreditado');
  });

  it('deduce los ingresos que no constituyen renta', () => {
    const conNoRenta = todasAceptadas.map((c) =>
      c.cuentaCodigo === '4101'
        ? { ...c, clasificacion: 'ingreso_no_renta' as const, fundamento: 'indemnización' }
        : c,
    );
    const rli = determinarRli(EMPRESA, asientos, plan(), conNoRenta, RANGO);

    expect(rli.totalDeducciones).toBe(100_000);
    expect(rli.rentaLiquidaImponible).toBe(-850_000);
  });

  it('se niega a determinar con una cuenta de resultado sin clasificar', () => {
    // Asumirla aceptada produciría una RLI menor que la real: una declaración
    // incorrecta que no se ve rota por ningún lado.
    expect(() =>
      determinarRli(EMPRESA, asientos, plan(), todasAceptadas.slice(0, 2), RANGO),
    ).toThrow(CuentasSinClasificar);
  });

  it('nombra todas las cuentas que falta clasificar', () => {
    expect([...cuentasSinClasificar(asientos, plan(), [], RANGO)].sort()).toEqual([
      '4101',
      '5101',
      '5102',
    ]);
  });

  it('no exige clasificar cuentas de resultado sin movimiento', () => {
    expect(cuentasSinClasificar(asientos, plan(), todasAceptadas, RANGO)).toHaveLength(0);
  });

  it('avisa de clasificaciones de cuentas que existen pero no se movieron', () => {
    // '1199' existe en el plan de las fixtures y no tuvo movimiento en enero.
    const conObsoleta = [
      ...todasAceptadas,
      { cuentaCodigo: '1199', clasificacion: 'gasto_rechazado' as const, fundamento: 'obsoleta' },
    ];
    const rli = determinarRli(EMPRESA, asientos, plan(), conObsoleta, RANGO);
    expect(rli.clasificacionesSinUso).toContain('1199');
    expect(rli.totalAgregados).toBe(0);
  });

  it('avisa de clasificaciones que apuntan a cuentas inexistentes', () => {
    // Ignorarlas en silencio esconde el caso normal: la cuenta se renombró, y
    // el gasto que esa clasificación cubría hoy entra sin ajuste por otra.
    const rli = determinarRli(
      EMPRESA,
      asientos,
      plan(),
      [...todasAceptadas, { cuentaCodigo: '9999', clasificacion: 'gasto_rechazado' as const, fundamento: 'x' }],
      RANGO,
    );
    expect(rli.clasificacionesHuerfanas).toEqual(['9999']);
  });

  it('exige fundamento junto a cada clasificación, para poder auditarla', () => {
    const rli = determinarRli(
      EMPRESA,
      asientos,
      plan(),
      todasAceptadas.map((c) =>
        c.cuentaCodigo === '5101'
          ? { ...c, clasificacion: 'gasto_rechazado' as const, fundamento: 'artículo 33 N°1' }
          : c,
      ),
      RANGO,
    );
    expect(rli.agregados[0]?.fundamento).toBe('artículo 33 N°1');
  });
});
