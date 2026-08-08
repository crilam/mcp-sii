/**
 * Asientos de partida doble.
 *
 * La distinción central del modelo: **la inmutabilidad es del asiento, no del
 * borrador**. Una propuesta de una regla o del agente es un `Borrador`: se
 * edita y se descarta libremente, y no toca el mayor. Al aprobarse se convierte
 * en `Asiento`, recibe número correlativo y queda congelado para siempre.
 *
 * Sin esa separación habría que elegir entre ensuciar el libro oficial con
 * propuestas, o generar una reversión por cada corrección de una propuesta.
 */
import { type Pesos, validarMonto } from './dinero';
import { type PlanDeCuentas } from './cuentas';
import { type Calendario, type FechaContable, validarFecha } from './periodos';

/**
 * De dónde salió el asiento. Importa para auditoría y para saber qué revisar
 * cuando un saldo no cuadra: los de origen `agente` son los que nadie derivó
 * de una regla explícita.
 */
export type OrigenAsiento = 'manual' | 'regla' | 'agente' | 'apertura' | 'cierre';

export interface LineaAsiento {
  readonly cuentaCodigo: string;
  readonly debe: Pesos;
  readonly haber: Pesos;
  readonly glosa?: string;
}

export interface Borrador {
  readonly id: string;
  readonly empresaRut: string;
  readonly fecha: FechaContable;
  readonly glosa: string;
  readonly origen: OrigenAsiento;
  /** Documento que lo motiva: folio de una factura, liquidación, etc. */
  readonly referencia?: string;
  readonly lineas: readonly LineaAsiento[];
}

/** Un borrador aprobado. Nada de esto cambia nunca más. */
export interface Asiento extends Borrador {
  readonly numero: number;
  readonly aprobadoPor: string;
  readonly aprobadoEn: string;
  /** Presente sólo si este asiento revierte a otro. */
  readonly revierteNumero?: number;
}

export interface ProblemaDeAsiento {
  readonly codigo:
    | 'descuadre'
    | 'sin-lineas-suficientes'
    | 'linea-en-ambas-columnas'
    | 'linea-sin-monto'
    | 'cuenta-inexistente'
    | 'cuenta-no-hoja'
    | 'cuenta-inactiva'
    | 'monto-invalido'
    | 'fecha-invalida'
    | 'periodo-no-disponible'
    | 'glosa-vacia';
  readonly detalle: string;
  /** Índice de la línea afectada, si el problema es de una línea. */
  readonly linea?: number;
}

export class AsientoInvalido extends Error {
  constructor(readonly problemas: readonly ProblemaDeAsiento[]) {
    super(`Asiento inválido:\n  ${problemas.map((p) => p.detalle).join('\n  ')}`);
    this.name = 'AsientoInvalido';
  }
}

export function totalDebe(lineas: readonly LineaAsiento[]): Pesos {
  return lineas.reduce((suma, l) => suma + l.debe, 0);
}

export function totalHaber(lineas: readonly LineaAsiento[]): Pesos {
  return lineas.reduce((suma, l) => suma + l.haber, 0);
}

/**
 * Devuelve todos los problemas, no el primero. La bandeja de borradores tiene
 * que poder mostrarlos juntos: corregir de a uno obliga a revalidar tantas
 * veces como errores haya.
 */
export function revisar(
  borrador: Borrador,
  plan: PlanDeCuentas,
  calendario: Calendario,
): readonly ProblemaDeAsiento[] {
  const problemas: ProblemaDeAsiento[] = [];

  if (borrador.glosa.trim() === '') {
    problemas.push({
      codigo: 'glosa-vacia',
      detalle: 'El asiento no tiene glosa. Un asiento sin glosa es ilegible en el libro diario.',
    });
  }

  try {
    validarFecha(borrador.fecha);
    try {
      calendario.exigirAbiertoPara(borrador.fecha);
    } catch (error) {
      problemas.push({
        codigo: 'periodo-no-disponible',
        detalle: (error as Error).message,
      });
    }
  } catch (error) {
    problemas.push({ codigo: 'fecha-invalida', detalle: (error as Error).message });
  }

  if (borrador.lineas.length < 2) {
    problemas.push({
      codigo: 'sin-lineas-suficientes',
      detalle: `Un asiento necesita al menos dos líneas; tiene ${borrador.lineas.length}.`,
    });
  }

  let montosSanos = true;

  borrador.lineas.forEach((linea, indice) => {
    try {
      validarMonto(linea.debe);
      validarMonto(linea.haber);
    } catch (error) {
      montosSanos = false;
      problemas.push({
        codigo: 'monto-invalido',
        detalle: `Línea ${indice + 1}: ${(error as Error).message}`,
        linea: indice,
      });
      return;
    }

    if (linea.debe !== 0 && linea.haber !== 0) {
      problemas.push({
        codigo: 'linea-en-ambas-columnas',
        detalle:
          `Línea ${indice + 1} (${linea.cuentaCodigo}) tiene debe y haber a la vez. ` +
          'Una línea carga o abona, no las dos: si no, el neto queda oculto dentro de la línea.',
        linea: indice,
      });
    }

    if (linea.debe === 0 && linea.haber === 0) {
      problemas.push({
        codigo: 'linea-sin-monto',
        detalle: `Línea ${indice + 1} (${linea.cuentaCodigo}) no mueve nada.`,
        linea: indice,
      });
    }

    const cuenta = plan.buscar(linea.cuentaCodigo);
    if (cuenta === undefined) {
      problemas.push({
        codigo: 'cuenta-inexistente',
        detalle: `Línea ${indice + 1}: la cuenta ${linea.cuentaCodigo} no existe en el plan.`,
        linea: indice,
      });
      return;
    }
    if (!plan.esHoja(linea.cuentaCodigo)) {
      problemas.push({
        codigo: 'cuenta-no-hoja',
        detalle:
          `Línea ${indice + 1}: ${linea.cuentaCodigo} (${cuenta.nombre}) tiene cuentas hijas. ` +
          'Sólo las cuentas hoja reciben movimientos, o su saldo mezclaría lo propio con lo agregado.',
        linea: indice,
      });
    }
    if (!cuenta.activa) {
      problemas.push({
        codigo: 'cuenta-inactiva',
        detalle: `Línea ${indice + 1}: ${linea.cuentaCodigo} (${cuenta.nombre}) está inactiva.`,
        linea: indice,
      });
    }
  });

  // Sumar montos inválidos daría un descuadre inventado encima del error real.
  if (montosSanos) {
    const debe = totalDebe(borrador.lineas);
    const haber = totalHaber(borrador.lineas);
    if (debe !== haber) {
      problemas.push({
        codigo: 'descuadre',
        detalle: `El asiento no cuadra: debe ${debe}, haber ${haber}, diferencia ${debe - haber}.`,
      });
    }
  }

  return problemas;
}

export function esAprobable(
  borrador: Borrador,
  plan: PlanDeCuentas,
  calendario: Calendario,
): boolean {
  return revisar(borrador, plan, calendario).length === 0;
}

export interface DatosDeAprobacion {
  readonly numero: number;
  readonly aprobadoPor: string;
  readonly aprobadoEn: string;
  readonly revierteNumero?: number;
}

/**
 * Convierte el borrador en asiento. Es el único camino al mayor, y valida acá
 * y no antes porque un borrador puede vivir descuadrado todo el tiempo que
 * haga falta mientras alguien lo termina de armar.
 */
export function aprobar(
  borrador: Borrador,
  plan: PlanDeCuentas,
  calendario: Calendario,
  datos: DatosDeAprobacion,
): Asiento {
  const problemas = revisar(borrador, plan, calendario);
  if (problemas.length > 0) throw new AsientoInvalido(problemas);

  return Object.freeze({
    ...borrador,
    lineas: Object.freeze(borrador.lineas.map((l) => Object.freeze({ ...l }))),
    numero: datos.numero,
    aprobadoPor: datos.aprobadoPor,
    aprobadoEn: datos.aprobadoEn,
    ...(datos.revierteNumero !== undefined ? { revierteNumero: datos.revierteNumero } : {}),
  });
}

/**
 * Construye el borrador que revierte a un asiento aprobado, intercambiando
 * debe y haber. Es la única forma de corregir: el mayor es append-only.
 *
 * La fecha es propia y no la del original, porque el período del original
 * puede estar cerrado y la corrección ocurre cuando se detecta, no cuando se
 * cometió el error.
 */
export function borradorDeReversion(
  original: Asiento,
  id: string,
  fecha: FechaContable,
  motivo: string,
): Borrador {
  return {
    id,
    empresaRut: original.empresaRut,
    fecha: validarFecha(fecha),
    glosa: `Reversión del asiento ${original.numero}: ${motivo}`,
    origen: original.origen,
    ...(original.referencia !== undefined ? { referencia: original.referencia } : {}),
    lineas: original.lineas.map((l) => ({
      cuentaCodigo: l.cuentaCodigo,
      debe: l.haber,
      haber: l.debe,
      ...(l.glosa !== undefined ? { glosa: l.glosa } : {}),
    })),
  };
}
