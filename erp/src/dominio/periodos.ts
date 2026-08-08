/**
 * Períodos contables mensuales.
 *
 * Las fechas se manejan como cadenas `AAAA-MM-DD` y no como `Date`. Un `Date`
 * lleva hora y zona horaria: `new Date('2026-01-01')` es medianoche UTC, que en
 * Chile es el 31 de diciembre. Un asiento del primer día del ejercicio se
 * correría al ejercicio anterior, y el error aparecería sólo en los cierres.
 */

export type FechaContable = string; // AAAA-MM-DD

const FORMATO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

export class FechaInvalida extends Error {
  constructor(
    readonly valor: unknown,
    motivo: string,
  ) {
    super(`Fecha inválida (${String(valor)}): ${motivo}`);
    this.name = 'FechaInvalida';
  }
}

export function validarFecha(valor: unknown): FechaContable {
  if (typeof valor !== 'string') throw new FechaInvalida(valor, 'no es una cadena');

  const partes = FORMATO_FECHA.exec(valor);
  if (partes === null) throw new FechaInvalida(valor, 'no tiene el formato AAAA-MM-DD');

  const anio = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);

  if (mes < 1 || mes > 12) throw new FechaInvalida(valor, `mes fuera de rango: ${mes}`);
  if (dia < 1 || dia > diasDelMes(anio, mes)) {
    throw new FechaInvalida(valor, `día fuera de rango para ${anio}-${partes[2]}: ${dia}`);
  }

  return valor;
}

function diasDelMes(anio: number, mes: number): number {
  const largos = [31, esBisiesto(anio) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return largos[mes - 1] as number;
}

function esBisiesto(anio: number): boolean {
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;
}

/** Identificador de período: `AAAAMM`, el mismo formato que usa el SII. */
export type ClavePeriodo = string;

export function periodoDe(fecha: FechaContable): ClavePeriodo {
  const partes = FORMATO_FECHA.exec(validarFecha(fecha)) as RegExpExecArray;
  return `${partes[1]}${partes[2]}`;
}

export function anioDe(periodo: ClavePeriodo): number {
  return Number(periodo.slice(0, 4));
}

export type EstadoPeriodo = 'abierto' | 'cerrado';

export interface Periodo {
  readonly clave: ClavePeriodo;
  readonly estado: EstadoPeriodo;
}

export class PeriodoNoRegistrado extends Error {
  constructor(readonly clave: ClavePeriodo) {
    super(
      `El período ${clave} no existe en el calendario contable. ` +
        'Un asiento sólo puede registrarse en un período abierto declarado explícitamente.',
    );
    this.name = 'PeriodoNoRegistrado';
  }
}

export class PeriodoCerrado extends Error {
  constructor(readonly clave: ClavePeriodo) {
    super(`El período ${clave} está cerrado y no admite asientos nuevos.`);
    this.name = 'PeriodoCerrado';
  }
}

export class ReaperturaBloqueada extends Error {
  constructor(
    readonly clave: ClavePeriodo,
    readonly cerradosPosteriores: readonly ClavePeriodo[],
  ) {
    super(
      `No se puede reabrir ${clave}: hay períodos posteriores cerrados ` +
        `(${cerradosPosteriores.join(', ')}). Reabrir dejaría esos cierres apoyados ` +
        'en saldos que aún pueden cambiar. Reabrí primero los posteriores, del más reciente al más antiguo.',
    );
    this.name = 'ReaperturaBloqueada';
  }
}

/**
 * El calendario es inmutable: cerrar o reabrir devuelve uno nuevo. Así una
 * operación fallida no deja el calendario a medio modificar.
 */
export class Calendario {
  private readonly periodos: ReadonlyMap<ClavePeriodo, EstadoPeriodo>;

  constructor(periodos: readonly Periodo[] = []) {
    this.periodos = new Map(periodos.map((p) => [p.clave, p.estado]));
  }

  estadoDe(clave: ClavePeriodo): EstadoPeriodo | undefined {
    return this.periodos.get(clave);
  }

  /** Lanza si la fecha no cae en un período abierto y declarado. */
  exigirAbiertoPara(fecha: FechaContable): void {
    const clave = periodoDe(fecha);
    const estado = this.periodos.get(clave);
    if (estado === undefined) throw new PeriodoNoRegistrado(clave);
    if (estado === 'cerrado') throw new PeriodoCerrado(clave);
  }

  abrir(clave: ClavePeriodo): Calendario {
    return this.con(clave, 'abierto');
  }

  cerrar(clave: ClavePeriodo): Calendario {
    if (this.periodos.get(clave) === undefined) throw new PeriodoNoRegistrado(clave);
    return this.con(clave, 'cerrado');
  }

  /**
   * Reabrir exige que no haya cierres posteriores: un cierre posterior ya
   * consumió los saldos de este período, y modificarlos después lo invalidaría
   * en silencio.
   */
  reabrir(clave: ClavePeriodo): Calendario {
    if (this.periodos.get(clave) === undefined) throw new PeriodoNoRegistrado(clave);

    const posterioresCerrados = [...this.periodos.entries()]
      .filter(([otra, estado]) => otra > clave && estado === 'cerrado')
      .map(([otra]) => otra)
      .sort();

    if (posterioresCerrados.length > 0) {
      throw new ReaperturaBloqueada(clave, posterioresCerrados);
    }

    return this.con(clave, 'abierto');
  }

  todos(): readonly Periodo[] {
    return [...this.periodos.entries()]
      .map(([clave, estado]) => ({ clave, estado }))
      .sort((a, b) => a.clave.localeCompare(b.clave));
  }

  private con(clave: ClavePeriodo, estado: EstadoPeriodo): Calendario {
    const siguiente = new Map(this.periodos);
    siguiente.set(clave, estado);
    return new Calendario([...siguiente.entries()].map(([c, e]) => ({ clave: c, estado: e })));
  }
}
