/**
 * Mayor y estados financieros.
 *
 * Todo acá se deriva de las líneas de los asientos aprobados. No hay saldo
 * almacenado como campo mutable: un saldo guardado que se desincroniza de sus
 * líneas es un error que ningún reporte puede detectar, porque el reporte lee
 * el saldo, no las líneas.
 *
 * Si el volumen lo exige, se agrega un saldo materializado por cuenta y
 * período, recalculado al aprobar — pero la fuente de verdad sigue siendo esto.
 */
import { type Asiento, type LineaAsiento } from './asiento';
import { type Pesos } from './dinero';
import { type PlanDeCuentas, type TipoCuenta, esDeResultado, saldoNatural } from './cuentas';
import { type FechaContable } from './periodos';

export interface MovimientoDeMayor {
  readonly numero: number;
  readonly fecha: FechaContable;
  readonly glosa: string;
  readonly contrapartida: readonly string[];
  readonly debe: Pesos;
  readonly haber: Pesos;
  /** Saldo deudor acumulado hasta este movimiento inclusive. */
  readonly saldoAcumulado: Pesos;
}

export interface RangoDeFechas {
  readonly desde?: FechaContable;
  readonly hasta?: FechaContable;
}

function dentroDelRango(fecha: FechaContable, rango: RangoDeFechas): boolean {
  if (rango.desde !== undefined && fecha < rango.desde) return false;
  if (rango.hasta !== undefined && fecha > rango.hasta) return false;
  return true;
}

/** Orden estable del libro: por fecha, y a igual fecha por número correlativo. */
function enOrdenDeLibro(asientos: readonly Asiento[]): readonly Asiento[] {
  return [...asientos].sort((a, b) =>
    a.fecha === b.fecha ? a.numero - b.numero : a.fecha.localeCompare(b.fecha),
  );
}

/**
 * Saldo deudor de una cuenta: positivo cuando el debe supera al haber, sea cual
 * sea el tipo de la cuenta. La lectura según el signo natural la hacen los
 * reportes; acá no se interpreta.
 */
export function saldoDeudor(
  asientos: readonly Asiento[],
  cuentaCodigo: string,
  rango: RangoDeFechas = {},
): Pesos {
  let saldo = 0;
  for (const asiento of asientos) {
    if (!dentroDelRango(asiento.fecha, rango)) continue;
    for (const linea of asiento.lineas) {
      if (linea.cuentaCodigo !== cuentaCodigo) continue;
      saldo += linea.debe - linea.haber;
    }
  }
  return saldo;
}

/** El mayor de una cuenta: sus movimientos en orden, con saldo corrido. */
export function mayorDe(
  asientos: readonly Asiento[],
  cuentaCodigo: string,
  rango: RangoDeFechas = {},
): readonly MovimientoDeMayor[] {
  const movimientos: MovimientoDeMayor[] = [];
  let saldo = 0;

  for (const asiento of enOrdenDeLibro(asientos)) {
    if (!dentroDelRango(asiento.fecha, rango)) continue;

    const propias = asiento.lineas.filter((l) => l.cuentaCodigo === cuentaCodigo);
    if (propias.length === 0) continue;

    const debe = propias.reduce((s, l) => s + l.debe, 0);
    const haber = propias.reduce((s, l) => s + l.haber, 0);
    saldo += debe - haber;

    movimientos.push({
      numero: asiento.numero,
      fecha: asiento.fecha,
      glosa: asiento.glosa,
      contrapartida: contrapartidasDe(asiento.lineas, cuentaCodigo),
      debe,
      haber,
      saldoAcumulado: saldo,
    });
  }

  return movimientos;
}

function contrapartidasDe(
  lineas: readonly LineaAsiento[],
  cuentaCodigo: string,
): readonly string[] {
  return [...new Set(lineas.map((l) => l.cuentaCodigo).filter((c) => c !== cuentaCodigo))];
}

export interface FilaDeComprobacion {
  readonly cuentaCodigo: string;
  readonly nombre: string;
  readonly tipo: TipoCuenta;
  readonly debitos: Pesos;
  readonly creditos: Pesos;
  readonly saldoDeudor: Pesos;
  readonly saldoAcreedor: Pesos;
}

export interface BalanceDeComprobacion {
  readonly filas: readonly FilaDeComprobacion[];
  readonly totalDebitos: Pesos;
  readonly totalCreditos: Pesos;
  readonly totalSaldoDeudor: Pesos;
  readonly totalSaldoAcreedor: Pesos;
  /**
   * La verificación de que la partida doble se sostiene en todo el conjunto.
   * Si es falso, hay un asiento aprobado descuadrado — que no debería existir,
   * así que es señal de corrupción, no de un error de carga.
   */
  readonly cuadra: boolean;
}

export function balanceDeComprobacion(
  asientos: readonly Asiento[],
  plan: PlanDeCuentas,
  rango: RangoDeFechas = {},
): BalanceDeComprobacion {
  const filas: FilaDeComprobacion[] = [];

  for (const cuenta of plan.hojas()) {
    let debitos = 0;
    let creditos = 0;

    for (const asiento of asientos) {
      if (!dentroDelRango(asiento.fecha, rango)) continue;
      for (const linea of asiento.lineas) {
        if (linea.cuentaCodigo !== cuenta.codigo) continue;
        debitos += linea.debe;
        creditos += linea.haber;
      }
    }

    if (debitos === 0 && creditos === 0) continue;

    const neto = debitos - creditos;
    filas.push({
      cuentaCodigo: cuenta.codigo,
      nombre: cuenta.nombre,
      tipo: cuenta.tipo,
      debitos,
      creditos,
      saldoDeudor: neto > 0 ? neto : 0,
      saldoAcreedor: neto < 0 ? -neto : 0,
    });
  }

  filas.sort((a, b) => a.cuentaCodigo.localeCompare(b.cuentaCodigo));

  const totalDebitos = filas.reduce((s, f) => s + f.debitos, 0);
  const totalCreditos = filas.reduce((s, f) => s + f.creditos, 0);
  const totalSaldoDeudor = filas.reduce((s, f) => s + f.saldoDeudor, 0);
  const totalSaldoAcreedor = filas.reduce((s, f) => s + f.saldoAcreedor, 0);

  return {
    filas,
    totalDebitos,
    totalCreditos,
    totalSaldoDeudor,
    totalSaldoAcreedor,
    cuadra: totalDebitos === totalCreditos && totalSaldoDeudor === totalSaldoAcreedor,
  };
}

export interface LineaDeEstado {
  readonly cuentaCodigo: string;
  readonly nombre: string;
  /** Monto en el signo natural de la cuenta: siempre positivo si es normal. */
  readonly monto: Pesos;
}

export interface EstadoDeResultados {
  readonly desde?: FechaContable;
  readonly hasta?: FechaContable;
  readonly ingresos: readonly LineaDeEstado[];
  readonly gastos: readonly LineaDeEstado[];
  readonly totalIngresos: Pesos;
  readonly totalGastos: Pesos;
  /** Positivo es utilidad, negativo es pérdida. */
  readonly resultado: Pesos;
}

export function estadoDeResultados(
  asientos: readonly Asiento[],
  plan: PlanDeCuentas,
  rango: RangoDeFechas = {},
): EstadoDeResultados {
  const ingresos: LineaDeEstado[] = [];
  const gastos: LineaDeEstado[] = [];

  for (const cuenta of plan.hojas()) {
    if (!esDeResultado(cuenta.tipo)) continue;

    const neto = saldoDeudor(asientos, cuenta.codigo, rango);
    if (neto === 0) continue;

    const linea: LineaDeEstado = {
      cuentaCodigo: cuenta.codigo,
      nombre: cuenta.nombre,
      // En el signo natural: los ingresos son acreedores, los gastos deudores.
      monto: saldoNatural(cuenta.tipo) === 'deudor' ? neto : -neto,
    };

    if (cuenta.tipo === 'ingreso') ingresos.push(linea);
    else gastos.push(linea);
  }

  const totalIngresos = ingresos.reduce((s, l) => s + l.monto, 0);
  const totalGastos = gastos.reduce((s, l) => s + l.monto, 0);

  return {
    ...(rango.desde !== undefined ? { desde: rango.desde } : {}),
    ...(rango.hasta !== undefined ? { hasta: rango.hasta } : {}),
    ingresos: ingresos.sort((a, b) => a.cuentaCodigo.localeCompare(b.cuentaCodigo)),
    gastos: gastos.sort((a, b) => a.cuentaCodigo.localeCompare(b.cuentaCodigo)),
    totalIngresos,
    totalGastos,
    resultado: totalIngresos - totalGastos,
  };
}

export interface BalanceGeneral {
  readonly hasta?: FechaContable;
  readonly activos: readonly LineaDeEstado[];
  readonly pasivos: readonly LineaDeEstado[];
  readonly patrimonio: readonly LineaDeEstado[];
  readonly totalActivos: Pesos;
  readonly totalPasivos: Pesos;
  /** Patrimonio contable más el resultado del ejercicio aún no cerrado. */
  readonly totalPatrimonio: Pesos;
  readonly resultadoDelEjercicio: Pesos;
  /** Activo igual a pasivo más patrimonio. */
  readonly cuadra: boolean;
}

/**
 * `inicioDelEjercicio` acota qué resultado se incorpora al patrimonio. Sin él,
 * un balance del segundo año sumaría también la utilidad del primero, que ya
 * fue traspasada a patrimonio por el asiento de cierre — contándola dos veces.
 */
export function balanceGeneral(
  asientos: readonly Asiento[],
  plan: PlanDeCuentas,
  hasta: FechaContable,
  inicioDelEjercicio: FechaContable,
): BalanceGeneral {
  const activos: LineaDeEstado[] = [];
  const pasivos: LineaDeEstado[] = [];
  const patrimonio: LineaDeEstado[] = [];

  for (const cuenta of plan.hojas()) {
    if (esDeResultado(cuenta.tipo)) continue;

    const neto = saldoDeudor(asientos, cuenta.codigo, { hasta });
    if (neto === 0) continue;

    const linea: LineaDeEstado = {
      cuentaCodigo: cuenta.codigo,
      nombre: cuenta.nombre,
      monto: saldoNatural(cuenta.tipo) === 'deudor' ? neto : -neto,
    };

    if (cuenta.tipo === 'activo') activos.push(linea);
    else if (cuenta.tipo === 'pasivo') pasivos.push(linea);
    else patrimonio.push(linea);
  }

  const resultado = estadoDeResultados(asientos, plan, {
    desde: inicioDelEjercicio,
    hasta,
  }).resultado;

  const porCodigo = (a: LineaDeEstado, b: LineaDeEstado) =>
    a.cuentaCodigo.localeCompare(b.cuentaCodigo);

  const totalActivos = activos.reduce((s, l) => s + l.monto, 0);
  const totalPasivos = pasivos.reduce((s, l) => s + l.monto, 0);
  const totalPatrimonio = patrimonio.reduce((s, l) => s + l.monto, 0) + resultado;

  return {
    hasta,
    activos: activos.sort(porCodigo),
    pasivos: pasivos.sort(porCodigo),
    patrimonio: patrimonio.sort(porCodigo),
    totalActivos,
    totalPasivos,
    totalPatrimonio,
    resultadoDelEjercicio: resultado,
    cuadra: totalActivos === totalPasivos + totalPatrimonio,
  };
}
