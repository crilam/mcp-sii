/**
 * Motor de reglas: convierte documentos del SII en borradores de asiento.
 *
 * Las reglas son **datos**, no funciones. Tienen que poder guardarse en la
 * base, editarse desde la interfaz, y nacer de una propuesta del agente que
 * alguien aprobó. Una regla escrita como código cerraría las tres puertas.
 *
 * El motor no aprueba nada: produce borradores. Lo que ninguna regla cubre
 * queda sin contabilizar y a la vista, que es mejor que contabilizado a medias.
 */
import { type Borrador, type LineaAsiento, totalDebe, totalHaber } from '../dominio/asiento';
import { type Operacion, type DocumentoIngestado, restaDelPeriodo } from './documento';
import { type Pesos } from '../dominio/dinero';

/** Qué monto del documento usa una línea de la plantilla. */
export type CampoMonto = 'neto' | 'exento' | 'iva' | 'total';

export interface Condicion {
  readonly operacion?: Operacion;
  /** Códigos del SII. Vacío o ausente significa cualquiera. */
  readonly tiposDoc?: readonly number[];
  /** Para reglas específicas de un proveedor o cliente. */
  readonly contraparteRut?: string;
}

export interface LineaPlantilla {
  readonly cuenta: string;
  readonly columna: 'debe' | 'haber';
  readonly monto: CampoMonto;
  readonly glosa?: string;
}

export interface Regla {
  readonly id: string;
  readonly nombre: string;
  /** Mayor gana. Permite una regla general y excepciones por contraparte. */
  readonly prioridad: number;
  readonly condicion: Condicion;
  readonly lineas: readonly LineaPlantilla[];
  readonly activa: boolean;
}

export class ReglaDefectuosa extends Error {
  constructor(
    readonly regla: Regla,
    readonly documento: DocumentoIngestado,
    motivo: string,
  ) {
    super(`La regla "${regla.nombre}" (${regla.id}) no produce un asiento válido: ${motivo}`);
    this.name = 'ReglaDefectuosa';
  }
}

function montoDe(documento: DocumentoIngestado, campo: CampoMonto): Pesos {
  switch (campo) {
    case 'neto':
      return documento.montoNeto;
    case 'exento':
      return documento.montoExento;
    case 'iva':
      return documento.montoIva;
    case 'total':
      return documento.montoTotal;
  }
}

export function reglaAplica(regla: Regla, documento: DocumentoIngestado): boolean {
  if (!regla.activa) return false;
  if (regla.condicion.operacion !== undefined && regla.condicion.operacion !== documento.operacion) {
    return false;
  }
  if (
    regla.condicion.tiposDoc !== undefined &&
    regla.condicion.tiposDoc.length > 0 &&
    !regla.condicion.tiposDoc.includes(documento.tipoDocCodigo)
  ) {
    return false;
  }
  if (
    regla.condicion.contraparteRut !== undefined &&
    regla.condicion.contraparteRut !== documento.contraparteRut
  ) {
    return false;
  }
  return true;
}

/**
 * La regla de mayor prioridad que aplica. A igual prioridad gana la más
 * específica: una regla con contraparte fijada le gana a la genérica, o si no
 * el resultado dependería del orden en que están guardadas.
 */
export function reglaPara(
  reglas: readonly Regla[],
  documento: DocumentoIngestado,
): Regla | undefined {
  const candidatas = reglas.filter((r) => reglaAplica(r, documento));
  if (candidatas.length === 0) return undefined;

  return [...candidatas].sort((a, b) => {
    if (a.prioridad !== b.prioridad) return b.prioridad - a.prioridad;
    const especificidad = (r: Regla) =>
      (r.condicion.contraparteRut !== undefined ? 2 : 0) +
      (r.condicion.tiposDoc !== undefined && r.condicion.tiposDoc.length > 0 ? 1 : 0);
    if (especificidad(a) !== especificidad(b)) return especificidad(b) - especificidad(a);
    return a.id.localeCompare(b.id);
  })[0];
}

export interface Contabilizacion {
  readonly documento: DocumentoIngestado;
  readonly regla: Regla;
  readonly borrador: Borrador;
}

/**
 * Aplica una regla y devuelve el borrador.
 *
 * Las notas de crédito y débito invierten las columnas. Sus montos llegan
 * positivos pero restan del período: contabilizarlas con la misma orientación
 * que la factura duplicaría el efecto en vez de anularlo, y el balance
 * cuadraría igual porque el asiento en sí está cuadrado.
 */
export function contabilizar(
  regla: Regla,
  documento: DocumentoIngestado,
  id: string,
): Contabilizacion {
  const invertir = restaDelPeriodo(documento.tipoDocCodigo);

  const lineas: LineaAsiento[] = [];
  for (const plantilla of regla.lineas) {
    const monto = montoDe(documento, plantilla.monto);
    // Una línea en cero rompe la invariante del asiento. Omitirla es correcto:
    // un documento exento no tiene por qué arrastrar una línea de IVA vacía.
    if (monto === 0) continue;

    const columna = invertir
      ? plantilla.columna === 'debe'
        ? 'haber'
        : 'debe'
      : plantilla.columna;

    lineas.push({
      cuentaCodigo: plantilla.cuenta,
      debe: columna === 'debe' ? monto : 0,
      haber: columna === 'haber' ? monto : 0,
      ...(plantilla.glosa !== undefined ? { glosa: plantilla.glosa } : {}),
    });
  }

  if (lineas.length < 2) {
    throw new ReglaDefectuosa(
      regla,
      documento,
      `quedaron ${lineas.length} líneas con monto. ` +
        'Revisá si la regla usa campos que este documento trae en cero.',
    );
  }

  const debe = totalDebe(lineas);
  const haber = totalHaber(lineas);
  if (debe !== haber) {
    // Fallar acá y no emitir el borrador: un borrador descuadrado va a la
    // bandeja y alguien lo va a querer arreglar a mano, cuando lo que está mal
    // es la regla y va a repetirse en cada documento que la active.
    throw new ReglaDefectuosa(
      regla,
      documento,
      `el asiento resultante no cuadra: debe ${debe}, haber ${haber}, diferencia ${debe - haber}`,
    );
  }

  return {
    documento,
    regla,
    borrador: {
      id,
      empresaRut: documento.empresaRut,
      fecha: documento.fecha,
      glosa: glosaDe(documento),
      origen: 'regla',
      referencia: `${documento.tipoDocCodigo}-${documento.folio}`,
      lineas,
    },
  };
}

function glosaDe(documento: DocumentoIngestado): string {
  const verbo = documento.operacion === 'compra' ? 'Compra a' : 'Venta a';
  const nombre = documento.contraparteNombre.trim() === '' ? documento.contraparteRut : documento.contraparteNombre;
  return `${verbo} ${nombre}, documento ${documento.tipoDocCodigo} folio ${documento.folio}`;
}

export interface ResultadoDeContabilizacion {
  readonly contabilizados: readonly Contabilizacion[];
  /** Documentos que ninguna regla cubre. Quedan a la vista, no contabilizados. */
  readonly sinRegla: readonly DocumentoIngestado[];
  /** Documentos cuya regla produce un asiento inválido. El problema es la regla. */
  readonly conReglaDefectuosa: readonly { documento: DocumentoIngestado; error: ReglaDefectuosa }[];
}

/**
 * Contabiliza un lote. No se detiene en el primer problema: un documento que
 * ninguna regla cubre no debe impedir que los otros cien se contabilicen.
 */
export function contabilizarLote(
  reglas: readonly Regla[],
  documentos: readonly DocumentoIngestado[],
  idDe: (documento: DocumentoIngestado, indice: number) => string,
): ResultadoDeContabilizacion {
  const contabilizados: Contabilizacion[] = [];
  const sinRegla: DocumentoIngestado[] = [];
  const conReglaDefectuosa: { documento: DocumentoIngestado; error: ReglaDefectuosa }[] = [];

  documentos.forEach((documento, indice) => {
    const regla = reglaPara(reglas, documento);
    if (regla === undefined) {
      sinRegla.push(documento);
      return;
    }

    try {
      contabilizados.push(contabilizar(regla, documento, idDe(documento, indice)));
    } catch (error) {
      if (error instanceof ReglaDefectuosa) {
        conReglaDefectuosa.push({ documento, error });
        return;
      }
      throw error;
    }
  });

  return { contabilizados, sinRegla, conReglaDefectuosa };
}
