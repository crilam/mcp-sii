/**
 * Determinación mensual del IVA.
 *
 * Los insumos salen del RCV, que ya se ingesta y es verificable contra el
 * portal. La aritmética es del sistema.
 *
 * El punto delicado es el **remanente de crédito fiscal**: se arrastra de un
 * período al siguiente, así que un error no se queda quieto — se propaga hacia
 * adelante hasta que alguien cuadre a mano meses después. Por eso acá el
 * remanente anterior nunca se asume: o viene de una determinación cerrada del
 * período anterior, o se declara explícitamente que este es el primer período.
 */
import { type ClavePeriodo, periodoDe } from '../dominio/periodos';
import { type Pesos } from '../dominio/dinero';
import { type DocumentoIngestado, restaDelPeriodo } from '../ingesta/documento';

export class RemanenteNoDisponible extends Error {
  constructor(
    readonly periodo: ClavePeriodo,
    readonly periodoAnterior: ClavePeriodo,
  ) {
    super(
      `No se puede determinar el IVA de ${periodo}: falta el remanente de crédito fiscal que ` +
        `viene de ${periodoAnterior}. Asumirlo en cero declararía de más y el error se ` +
        'arrastraría a todos los períodos siguientes. Determiná primero el período anterior, ' +
        'o declará este como el primero con `esPrimerPeriodo`.',
    );
    this.name = 'RemanenteNoDisponible';
  }
}

export class PeriodoInconsistente extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'PeriodoInconsistente';
  }
}

export interface AporteDeDocumento {
  readonly clave: string;
  readonly tipoDocCodigo: number;
  readonly folio: string;
  /** Con signo: las notas de crédito restan. */
  readonly neto: Pesos;
  readonly exento: Pesos;
  readonly iva: Pesos;
}

export interface DeterminacionDeIva {
  readonly empresaRut: string;
  readonly periodo: ClavePeriodo;

  readonly ventasNetas: Pesos;
  readonly ventasExentas: Pesos;
  readonly debitoFiscal: Pesos;

  readonly comprasNetas: Pesos;
  readonly comprasExentas: Pesos;
  readonly creditoFiscalDelPeriodo: Pesos;

  /** Lo que venía arrastrado del período anterior. */
  readonly remanenteAnterior: Pesos;
  readonly creditoFiscalTotal: Pesos;

  /** Positivo cuando hay que pagar. Cero si el crédito alcanza. */
  readonly impuestoAPagar: Pesos;
  /** Positivo cuando sobra crédito y pasa al período siguiente. */
  readonly remanenteParaElSiguiente: Pesos;

  /** Qué documentos entraron, para poder rastrear cualquier cifra hasta su origen. */
  readonly aportes: readonly AporteDeDocumento[];
  readonly documentosConsiderados: number;
}

export interface EntradaDeDeterminacion {
  readonly empresaRut: string;
  readonly periodo: ClavePeriodo;
  readonly documentos: readonly DocumentoIngestado[];
  /**
   * Remanente que viene del período anterior. Obligatorio salvo que
   * `esPrimerPeriodo` sea verdadero.
   */
  readonly remanenteAnterior?: Pesos;
  /**
   * Sólo para el primer período con contabilidad en este sistema. Declararlo
   * es explícito a propósito: es la única forma legítima de que el remanente
   * anterior sea cero.
   */
  readonly esPrimerPeriodo?: boolean;
}

/**
 * Determina el IVA del período.
 *
 * Un documento fuera del período **no se ignora en silencio**: es un error de
 * quien armó el lote, y contabilizarlo en el mes equivocado produce dos
 * declaraciones mal hechas en vez de una.
 */
export function determinarIva(entrada: EntradaDeDeterminacion): DeterminacionDeIva {
  const { empresaRut, periodo, documentos } = entrada;

  const remanenteAnterior = resolverRemanenteAnterior(entrada);

  const fueraDePeriodo = documentos.filter((d) => periodoDe(d.fecha) !== periodo);
  if (fueraDePeriodo.length > 0) {
    const ejemplos = fueraDePeriodo
      .slice(0, 3)
      .map((d) => `${d.tipoDocCodigo}-${d.folio} (${d.fecha})`)
      .join(', ');
    throw new PeriodoInconsistente(
      `${fueraDePeriodo.length} documento(s) no pertenecen al período ${periodo}: ${ejemplos}. ` +
        'Contabilizarlos acá dejaría mal este período y el suyo.',
    );
  }

  const deOtraEmpresa = documentos.filter((d) => d.empresaRut !== empresaRut);
  if (deOtraEmpresa.length > 0) {
    throw new PeriodoInconsistente(
      `${deOtraEmpresa.length} documento(s) son de otra empresa. La determinación es por empresa.`,
    );
  }

  const aportes: AporteDeDocumento[] = [];
  let ventasNetas = 0;
  let ventasExentas = 0;
  let debitoFiscal = 0;
  let comprasNetas = 0;
  let comprasExentas = 0;
  let creditoFiscalDelPeriodo = 0;

  for (const documento of documentos) {
    // Las notas de crédito llegan con montos positivos y restan del período.
    // El signo se aplica en un solo lugar, acá.
    const signo = restaDelPeriodo(documento.tipoDocCodigo) ? -1 : 1;

    const neto = signo * documento.montoNeto;
    const exento = signo * documento.montoExento;
    const iva = signo * documento.montoIva;

    if (documento.operacion === 'venta') {
      ventasNetas += neto;
      ventasExentas += exento;
      debitoFiscal += iva;
    } else {
      comprasNetas += neto;
      comprasExentas += exento;
      creditoFiscalDelPeriodo += iva;
    }

    aportes.push({
      clave: `${documento.operacion}|${documento.tipoDocCodigo}|${documento.folio}`,
      tipoDocCodigo: documento.tipoDocCodigo,
      folio: documento.folio,
      neto,
      exento,
      iva,
    });
  }

  const creditoFiscalTotal = creditoFiscalDelPeriodo + remanenteAnterior;
  const diferencia = debitoFiscal - creditoFiscalTotal;

  return {
    empresaRut,
    periodo,
    ventasNetas,
    ventasExentas,
    debitoFiscal,
    comprasNetas,
    comprasExentas,
    creditoFiscalDelPeriodo,
    remanenteAnterior,
    creditoFiscalTotal,
    impuestoAPagar: diferencia > 0 ? diferencia : 0,
    remanenteParaElSiguiente: diferencia < 0 ? -diferencia : 0,
    aportes,
    documentosConsiderados: documentos.length,
  };
}

function resolverRemanenteAnterior(entrada: EntradaDeDeterminacion): Pesos {
  if (entrada.esPrimerPeriodo === true) {
    if (entrada.remanenteAnterior !== undefined && entrada.remanenteAnterior !== 0) {
      throw new PeriodoInconsistente(
        `${entrada.periodo} se declaró como primer período pero trae un remanente anterior de ` +
          `${entrada.remanenteAnterior}. Si viene arrastrado, no es el primero.`,
      );
    }
    return 0;
  }

  if (entrada.remanenteAnterior === undefined) {
    throw new RemanenteNoDisponible(entrada.periodo, periodoAnterior(entrada.periodo));
  }

  if (entrada.remanenteAnterior < 0) {
    throw new PeriodoInconsistente(
      `El remanente anterior no puede ser negativo (${entrada.remanenteAnterior}). ` +
        'Un remanente negativo sería impuesto por pagar, y eso ya se declaró en su período.',
    );
  }

  return entrada.remanenteAnterior;
}

export function periodoAnterior(periodo: ClavePeriodo): ClavePeriodo {
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(4, 6));
  return mes === 1
    ? `${anio - 1}12`
    : `${anio}${String(mes - 1).padStart(2, '0')}`;
}

/**
 * Encadena varios períodos, pasando el remanente de uno al siguiente.
 *
 * Existe para que nadie tenga que encadenarlo a mano: hacerlo a mano es
 * exactamente donde se pierde un remanente y el error se descubre meses
 * después.
 */
export function determinarSerie(
  empresaRut: string,
  porPeriodo: ReadonlyMap<ClavePeriodo, readonly DocumentoIngestado[]>,
  primerPeriodo: ClavePeriodo,
): readonly DeterminacionDeIva[] {
  const periodos = [...porPeriodo.keys()].sort();
  const resultados: DeterminacionDeIva[] = [];
  let remanente: Pesos | undefined;

  for (const periodo of periodos) {
    if (periodo < primerPeriodo) {
      throw new PeriodoInconsistente(
        `El período ${periodo} es anterior al primero declarado (${primerPeriodo}).`,
      );
    }

    // Un hueco en la serie rompe el arrastre: el remanente del período que
    // falta se perdería y los siguientes declararían de más.
    if (resultados.length > 0) {
      const ultimo = resultados[resultados.length - 1] as DeterminacionDeIva;
      if (periodoAnterior(periodo) !== ultimo.periodo) {
        throw new PeriodoInconsistente(
          `Falta el período ${periodoAnterior(periodo)} entre ${ultimo.periodo} y ${periodo}. ` +
            'Sin él, el remanente arrastrado se pierde y los períodos siguientes declaran de más.',
        );
      }
    }

    const determinacion = determinarIva({
      empresaRut,
      periodo,
      documentos: porPeriodo.get(periodo) ?? [],
      ...(periodo === primerPeriodo
        ? { esPrimerPeriodo: true }
        : { remanenteAnterior: remanente as Pesos }),
    });

    resultados.push(determinacion);
    remanente = determinacion.remanenteParaElSiguiente;
  }

  return resultados;
}
