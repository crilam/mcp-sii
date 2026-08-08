/**
 * Determinación de la Renta Líquida Imponible a partir del resultado contable.
 *
 * La RLI parte del resultado del ejercicio y le aplica ajustes: se agregan los
 * gastos que la ley no acepta y se deducen los ingresos que no constituyen
 * renta.
 *
 * **Qué cuenta es un gasto rechazado no se deduce del nombre.** "Multas" suena
 * a gasto rechazado y "Asesorías" no, pero la clasificación depende del caso y
 * de la normativa, no del texto. Adivinarla produciría una RLI que se ve
 * razonable y está mal, y eso es una declaración de renta incorrecta.
 *
 * Por eso la clasificación es configuración por cuenta, cargada y auditable, y
 * una cuenta de resultado sin clasificar **detiene el cálculo** en vez de
 * asumirse aceptada.
 */
import { type Asiento } from '../dominio/asiento';
import { type PlanDeCuentas, esDeResultado } from '../dominio/cuentas';
import { type Pesos } from '../dominio/dinero';
import { estadoDeResultados, saldoDeudor } from '../dominio/mayor';
import { type FechaContable } from '../dominio/periodos';

/**
 * Cómo trata la ley a cada cuenta de resultado.
 *
 * - `aceptado`: entra al resultado y no se ajusta.
 * - `gasto_rechazado`: se agrega de vuelta a la RLI.
 * - `ingreso_no_renta`: se deduce de la RLI.
 */
export type ClasificacionTributaria = 'aceptado' | 'gasto_rechazado' | 'ingreso_no_renta';

export interface ClasificacionDeCuenta {
  readonly cuentaCodigo: string;
  readonly clasificacion: ClasificacionTributaria;
  /** Por qué se clasificó así: artículo, oficio, criterio del contador. */
  readonly fundamento: string;
}

export class CuentasSinClasificar extends Error {
  constructor(readonly cuentas: readonly string[]) {
    super(
      `No se puede determinar la RLI: ${cuentas.length} cuenta(s) de resultado con movimiento ` +
        `no están clasificadas tributariamente (${cuentas.join(', ')}).\n` +
        'Asumirlas aceptadas produciría una RLI menor que la real y una declaración incorrecta. ' +
        'Clasificá cada una con su fundamento.',
    );
    this.name = 'CuentasSinClasificar';
  }
}

export interface AjusteDeRli {
  readonly cuentaCodigo: string;
  readonly nombre: string;
  readonly clasificacion: Exclude<ClasificacionTributaria, 'aceptado'>;
  readonly fundamento: string;
  /** Con el signo con el que entra a la RLI: los agregados suman, las deducciones restan. */
  readonly monto: Pesos;
}

export interface DeterminacionDeRli {
  readonly empresaRut: string
  readonly desde: FechaContable;
  readonly hasta: FechaContable;
  /** Utilidad o pérdida según los libros, antes de ajustes tributarios. */
  readonly resultadoContable: Pesos;
  readonly agregados: readonly AjusteDeRli[];
  readonly deducciones: readonly AjusteDeRli[];
  readonly totalAgregados: Pesos;
  readonly totalDeducciones: Pesos;
  /** Positiva es renta imponible; negativa es pérdida tributaria. */
  readonly rentaLiquidaImponible: Pesos;
  /**
   * Cuentas clasificadas que no tuvieron movimiento. Se informan para que quien
   * revise note una clasificación que quizá quedó obsoleta.
   */
  readonly clasificacionesSinUso: readonly string[];
  /**
   * Clasificaciones que apuntan a cuentas que no existen en el plan.
   *
   * Se informan en vez de ignorarse: normalmente significa que la cuenta se
   * renombró y que el gasto que esa clasificación cubría hoy está entrando sin
   * ajuste por otra cuenta.
   */
  readonly clasificacionesHuerfanas: readonly string[];
}

/** Las cuentas de resultado con movimiento que todavía no tienen clasificación. */
export function cuentasSinClasificar(
  asientos: readonly Asiento[],
  plan: PlanDeCuentas,
  clasificaciones: readonly ClasificacionDeCuenta[],
  rango: { desde: FechaContable; hasta: FechaContable },
): readonly string[] {
  const clasificadas = new Set(clasificaciones.map((c) => c.cuentaCodigo));

  return plan
    .hojas()
    .filter((c) => esDeResultado(c.tipo))
    .filter((c) => saldoDeudor(asientos, c.codigo, rango) !== 0)
    .filter((c) => !clasificadas.has(c.codigo))
    .map((c) => c.codigo);
}

export function determinarRli(
  empresaRut: string,
  asientos: readonly Asiento[],
  plan: PlanDeCuentas,
  clasificaciones: readonly ClasificacionDeCuenta[],
  rango: { desde: FechaContable; hasta: FechaContable },
): DeterminacionDeRli {
  const sinClasificar = cuentasSinClasificar(asientos, plan, clasificaciones, rango);
  if (sinClasificar.length > 0) throw new CuentasSinClasificar(sinClasificar);

  const resultadoContable = estadoDeResultados(asientos, plan, rango).resultado;

  const agregados: AjusteDeRli[] = [];
  const deducciones: AjusteDeRli[] = [];
  const sinUso: string[] = [];
  const huerfanas: string[] = [];

  for (const clasificacion of clasificaciones) {
    const cuenta = plan.buscar(clasificacion.cuentaCodigo);
    if (cuenta === undefined) {
      huerfanas.push(clasificacion.cuentaCodigo);
      continue;
    }

    const saldo = saldoDeudor(asientos, cuenta.codigo, rango);
    if (saldo === 0) {
      sinUso.push(cuenta.codigo);
      continue;
    }
    if (clasificacion.clasificacion === 'aceptado') continue;

    if (clasificacion.clasificacion === 'gasto_rechazado') {
      // Un gasto rechazado tiene saldo deudor y ya restó del resultado
      // contable: se agrega de vuelta por su valor absoluto.
      agregados.push({
        cuentaCodigo: cuenta.codigo,
        nombre: cuenta.nombre,
        clasificacion: 'gasto_rechazado',
        fundamento: clasificacion.fundamento,
        monto: saldo,
      });
    } else {
      // Un ingreso no renta tiene saldo acreedor y ya sumó al resultado: se
      // deduce.
      deducciones.push({
        cuentaCodigo: cuenta.codigo,
        nombre: cuenta.nombre,
        clasificacion: 'ingreso_no_renta',
        fundamento: clasificacion.fundamento,
        monto: -saldo,
      });
    }
  }

  const totalAgregados = agregados.reduce((s, a) => s + a.monto, 0);
  const totalDeducciones = deducciones.reduce((s, d) => s + d.monto, 0);

  return {
    empresaRut,
    desde: rango.desde,
    hasta: rango.hasta,
    resultadoContable,
    agregados,
    deducciones,
    totalAgregados,
    totalDeducciones,
    rentaLiquidaImponible: resultadoContable + totalAgregados - totalDeducciones,
    clasificacionesSinUso: sinUso,
    clasificacionesHuerfanas: huerfanas,
  };
}
