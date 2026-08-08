/**
 * Cierre del ejercicio y apertura del siguiente.
 *
 * El cierre mensual no genera asientos: sólo bloquea el período. El anual sí,
 * y son dos:
 *
 *   1. **Cierre**: salda contra patrimonio todas las cuentas de resultado, que
 *      quedan en cero. Es lo que hace que el ejercicio siguiente empiece a
 *      contar ingresos y gastos desde cero.
 *   2. **Apertura**: vuelve a registrar los saldos de las cuentas de balance el
 *      primer día del ejercicio siguiente.
 *
 * Los dos se devuelven como borradores, no como asientos. Un cierre es
 * demasiado consecuente para entrar al mayor sin que alguien lo apruebe.
 */
import { type Asiento, type Borrador, type LineaAsiento } from './asiento';
import { type PlanDeCuentas, esDeResultado } from './cuentas';
import { saldoDeudor } from './mayor';
import { type FechaContable, validarFecha } from './periodos';

export class CierreImposible extends Error {
  constructor(motivo: string) {
    super(`No se puede cerrar el ejercicio: ${motivo}`);
    this.name = 'CierreImposible';
  }
}

export interface DatosDeCierre {
  readonly empresaRut: string;
  /** Último día del ejercicio que se cierra. */
  readonly fechaCierre: FechaContable;
  /** Primer día del ejercicio siguiente. */
  readonly fechaApertura: FechaContable;
  /** Primer día del ejercicio que se cierra, para acotar el resultado. */
  readonly inicioDelEjercicio: FechaContable;
  /**
   * Cuenta de patrimonio que recibe el resultado. Se exige explícita en vez de
   * deducirla del plan: qué cuenta absorbe la utilidad es una decisión
   * contable, y adivinarla dejaría el patrimonio mal compuesto sin que nada
   * lo delate, porque el balance cuadraría igual.
   */
  readonly cuentaResultadoAcumulado: string;
}

export interface ResultadoDelCierre {
  readonly cierre: Borrador;
  readonly apertura: Borrador;
  /** Positivo es utilidad, negativo es pérdida. */
  readonly resultado: number;
}

/**
 * Construye los borradores de cierre y apertura. No los aprueba: eso lo hace
 * quien tenga la autoridad para hacerlo, con las invariantes de `aprobar`.
 */
export function cerrarEjercicio(
  asientos: readonly Asiento[],
  plan: PlanDeCuentas,
  datos: DatosDeCierre,
): ResultadoDelCierre {
  validarFecha(datos.fechaCierre);
  validarFecha(datos.fechaApertura);
  validarFecha(datos.inicioDelEjercicio);

  if (datos.fechaApertura <= datos.fechaCierre) {
    throw new CierreImposible(
      `la apertura (${datos.fechaApertura}) no es posterior al cierre (${datos.fechaCierre})`,
    );
  }

  const cuentaDestino = plan.buscar(datos.cuentaResultadoAcumulado);
  if (cuentaDestino === undefined) {
    throw new CierreImposible(
      `la cuenta de resultado acumulado ${datos.cuentaResultadoAcumulado} no existe en el plan`,
    );
  }
  if (cuentaDestino.tipo !== 'patrimonio') {
    throw new CierreImposible(
      `la cuenta de resultado acumulado ${cuentaDestino.codigo} es ${cuentaDestino.tipo}; ` +
        'el resultado del ejercicio se traspasa a patrimonio',
    );
  }
  if (!plan.esHoja(cuentaDestino.codigo)) {
    throw new CierreImposible(
      `la cuenta de resultado acumulado ${cuentaDestino.codigo} tiene cuentas hijas`,
    );
  }

  const delEjercicio = { desde: datos.inicioDelEjercicio, hasta: datos.fechaCierre };

  // Saldar una cuenta es moverla al lado contrario de su saldo.
  const lineasDeCierre: LineaAsiento[] = [];
  let netoDeResultado = 0;

  for (const cuenta of plan.hojas()) {
    if (!esDeResultado(cuenta.tipo)) continue;

    const saldo = saldoDeudor(asientos, cuenta.codigo, delEjercicio);
    if (saldo === 0) continue;

    netoDeResultado += saldo;
    lineasDeCierre.push({
      cuentaCodigo: cuenta.codigo,
      debe: saldo < 0 ? -saldo : 0,
      haber: saldo > 0 ? saldo : 0,
      glosa: 'Saldo de cierre del ejercicio',
    });
  }

  if (lineasDeCierre.length === 0) {
    throw new CierreImposible(
      'no hay cuentas de resultado con movimiento en el ejercicio, así que no hay nada que cerrar',
    );
  }

  // `netoDeResultado` es deudor: positivo significa que los gastos superaron a
  // los ingresos, o sea pérdida. El resultado que se informa usa el signo
  // habitual, donde positivo es utilidad.
  const resultado = -netoDeResultado;

  lineasDeCierre.push({
    cuentaCodigo: cuentaDestino.codigo,
    debe: resultado < 0 ? -resultado : 0,
    haber: resultado > 0 ? resultado : 0,
    glosa: resultado >= 0 ? 'Utilidad del ejercicio' : 'Pérdida del ejercicio',
  });

  const cierre: Borrador = {
    id: `cierre-${datos.fechaCierre}`,
    empresaRut: datos.empresaRut,
    fecha: datos.fechaCierre,
    glosa: `Cierre del ejercicio al ${datos.fechaCierre}`,
    origen: 'cierre',
    lineas: lineasDeCierre,
  };

  // La apertura se calcula sobre el mayor con el cierre ya aplicado: si no, el
  // resultado del ejercicio no estaría todavía en patrimonio y la apertura
  // saldría descuadrada por exactamente ese monto.
  const conCierre = [
    ...asientos,
    {
      ...cierre,
      numero: Number.MAX_SAFE_INTEGER,
      aprobadoPor: 'simulación de cierre',
      aprobadoEn: datos.fechaCierre,
    } as Asiento,
  ];

  const lineasDeApertura: LineaAsiento[] = [];
  for (const cuenta of plan.hojas()) {
    if (esDeResultado(cuenta.tipo)) continue;

    const saldo = saldoDeudor(conCierre, cuenta.codigo, { hasta: datos.fechaCierre });
    if (saldo === 0) continue;

    lineasDeApertura.push({
      cuentaCodigo: cuenta.codigo,
      debe: saldo > 0 ? saldo : 0,
      haber: saldo < 0 ? -saldo : 0,
      glosa: 'Saldo de apertura',
    });
  }

  if (lineasDeApertura.length === 0) {
    throw new CierreImposible(
      'no hay saldos de balance que traspasar al ejercicio siguiente; ' +
        'revisá que el ejercicio que se cierra tenga movimientos',
    );
  }

  const apertura: Borrador = {
    id: `apertura-${datos.fechaApertura}`,
    empresaRut: datos.empresaRut,
    fecha: datos.fechaApertura,
    glosa: `Apertura del ejercicio al ${datos.fechaApertura}`,
    origen: 'apertura',
    lineas: lineasDeApertura,
  };

  return { cierre, apertura, resultado };
}
