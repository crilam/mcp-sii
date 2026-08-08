/**
 * Puente entre la liquidación y el mayor: convierte una nómina en un borrador
 * de asiento.
 *
 * Qué cuenta recibe cada concepto **no se adivina**. Un plan de cuentas de
 * remuneraciones varía entre empresas, y elegir por nombre parecido produciría
 * un asiento que cuadra y está imputado mal — el peor resultado posible, porque
 * el balance no lo delata.
 */
import { type Borrador, type LineaAsiento, totalDebe, totalHaber } from '../dominio/asiento';
import { type FechaContable } from '../dominio/periodos';
import { type Liquidacion } from './liquidacion';

/**
 * Los conceptos que una liquidación produce, y que hay que mapear a cuentas.
 *
 * Deliberadamente pocos: uno por naturaleza contable, no uno por cotización.
 * Separar AFP de salud en cuentas distintas es una decisión de la empresa, y
 * quien la quiera puede tener varias reglas.
 */
export interface CuentasDeRemuneraciones {
  /** Gasto por el bruto del trabajador. */
  readonly gastoRemuneraciones: string;
  /** Gasto por lo que aporta el empleador por encima del bruto. */
  readonly gastoAportesEmpleador: string;
  /** Pasivo: cotizaciones retenidas y aportadas, pendientes de enterar. */
  readonly cotizacionesPorPagar: string;
  /** Pasivo: impuesto único retenido, pendiente de enterar. */
  readonly retencionImpuestoUnico: string;
  /** Pasivo: el líquido que se le debe al trabajador. */
  readonly liquidosPorPagar: string;
}

export class CuentasDeRemuneracionesFaltantes extends Error {
  constructor(readonly faltantes: readonly string[]) {
    super(
      `Faltan cuentas para contabilizar la remuneración: ${faltantes.join(', ')}. ` +
        'No se eligen por nombre parecido: un asiento mal imputado cuadra igual y el balance no lo delata.',
    );
    this.name = 'CuentasDeRemuneracionesFaltantes';
  }
}

const CONCEPTOS: readonly (keyof CuentasDeRemuneraciones)[] = [
  'gastoRemuneraciones',
  'gastoAportesEmpleador',
  'cotizacionesPorPagar',
  'retencionImpuestoUnico',
  'liquidosPorPagar',
];

export function cuentasQueFaltan(
  cuentas: Partial<CuentasDeRemuneraciones>,
): readonly string[] {
  return CONCEPTOS.filter((c) => (cuentas[c] ?? '').trim() === '');
}

/**
 * Contabiliza una o varias liquidaciones en un solo asiento.
 *
 * Se agrupa la nómina completa a propósito: un asiento por trabajador llenaría
 * el libro diario de cientos de asientos idénticos en estructura, y el detalle
 * por persona ya vive en la liquidación.
 */
export function contabilizarNomina(
  liquidaciones: readonly Liquidacion[],
  cuentas: Partial<CuentasDeRemuneraciones>,
  id: string,
  empresaRut: string,
  fecha: FechaContable,
): Borrador {
  const faltantes = cuentasQueFaltan(cuentas);
  if (faltantes.length > 0) throw new CuentasDeRemuneracionesFaltantes(faltantes);
  const c = cuentas as CuentasDeRemuneraciones;

  if (liquidaciones.length === 0) {
    throw new Error('No hay liquidaciones que contabilizar.');
  }

  const periodos = new Set(liquidaciones.map((l) => l.periodo));
  if (periodos.size > 1) {
    // Mezclar períodos en un asiento haría imposible reconciliar la nómina de
    // un mes contra el gasto contabilizado.
    throw new Error(
      `Las liquidaciones son de más de un período (${[...periodos].sort().join(', ')}). ` +
        'La nómina se contabiliza por período.',
    );
  }

  const suma = (f: (l: Liquidacion) => number) => liquidaciones.reduce((s, l) => s + f(l), 0);

  const totalHaberes = suma((l) => l.totalHaberes);
  const cotizacionesTrabajador = suma((l) => l.totalCotizacionesTrabajador);
  const impuestoUnico = suma((l) => l.impuestoUnico);
  const liquidos = suma((l) => l.liquidoAPagar);
  const aportesEmpleador = suma((l) =>
    l.aportesDelEmpleador.reduce((s, a) => s + a.monto, 0),
  );

  const lineas: LineaAsiento[] = [];
  const agregar = (cuentaCodigo: string, columna: 'debe' | 'haber', monto: number, glosa: string) => {
    if (monto === 0) return; // una línea en cero rompe la invariante del asiento
    lineas.push({
      cuentaCodigo,
      debe: columna === 'debe' ? monto : 0,
      haber: columna === 'haber' ? monto : 0,
      glosa,
    });
  };

  agregar(c.gastoRemuneraciones, 'debe', totalHaberes, 'Remuneraciones del período');
  agregar(c.gastoAportesEmpleador, 'debe', aportesEmpleador, 'Aportes del empleador');

  // Las cotizaciones del trabajador se retienen del bruto; las del empleador se
  // suman al gasto. Las dos terminan en el mismo pasivo porque se enteran
  // juntas en la misma planilla.
  agregar(
    c.cotizacionesPorPagar,
    'haber',
    cotizacionesTrabajador + aportesEmpleador,
    'Cotizaciones previsionales por enterar',
  );
  agregar(c.retencionImpuestoUnico, 'haber', impuestoUnico, 'Impuesto único retenido');
  agregar(c.liquidosPorPagar, 'haber', liquidos, 'Líquidos por pagar');

  const debe = totalDebe(lineas);
  const haber = totalHaber(lineas);
  if (debe !== haber) {
    // Si esto ocurre, la liquidación es internamente incoherente y el problema
    // está en el motor de cálculo, no en la contabilización. Emitir el borrador
    // mandaría a alguien a cuadrarlo a mano mes tras mes.
    throw new Error(
      `La nómina no cuadra: debe ${debe}, haber ${haber}, diferencia ${debe - haber}. ` +
        'Revisá la liquidación, no el asiento.',
    );
  }

  return {
    id,
    empresaRut,
    fecha,
    glosa: `Remuneraciones ${[...periodos][0] as string} (${liquidaciones.length} liquidación(es))`,
    origen: 'regla',
    referencia: `nomina-${[...periodos][0] as string}`,
    lineas,
  };
}

/**
 * El impuesto único retenido que hay que declarar y enterar.
 *
 * Sale de la nómina y lo consume la declaración mensual; se expone aparte para
 * que quien arme el formulario no tenga que volver a recorrer las
 * liquidaciones.
 */
export function retencionesDelPeriodo(liquidaciones: readonly Liquidacion[]): number {
  return liquidaciones.reduce((s, l) => s + l.impuestoUnico, 0);
}
