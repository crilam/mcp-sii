/**
 * Documentos traídos del SII, normalizados para que el motor de reglas no
 * tenga que conocer la forma de cada tool del MCP.
 */
import { type FechaContable, validarFecha } from '../dominio/periodos';
import { type Pesos, validarMonto } from '../dominio/dinero';

/** Compra o venta, desde el punto de vista de la empresa. */
export type Operacion = 'compra' | 'venta';

/**
 * RUT genérico que el SII usa para toda contraparte sin RUT chileno.
 *
 * No identifica a nadie: **todos** los proveedores y clientes extranjeros
 * comparten este RUT. Tratarlo como identificador colapsaría documentos de
 * empresas distintas en uno solo.
 */
export const RUT_CONTRAPARTE_EXTRANJERA = '55555555-5';

export interface DocumentoIngestado {
  readonly empresaRut: string;
  readonly operacion: Operacion;
  /** Código del SII: 33 factura electrónica, 61 nota de crédito, etc. */
  readonly tipoDocCodigo: number;
  readonly folio: string;
  readonly fecha: FechaContable;
  readonly contraparteRut: string;
  readonly contraparteNombre: string;
  readonly montoNeto: Pesos;
  readonly montoExento: Pesos;
  readonly montoIva: Pesos;
  readonly montoTotal: Pesos;
  /** Presente en notas de crédito y débito: qué documento corrigen. */
  readonly referenciaFolio?: string;
  readonly referenciaTipoDoc?: number;
}

/**
 * Los tipos que **restan** del período aunque sus montos vengan positivos.
 *
 * Sumar el `montoTotal` de un detalle de notas de crédito da un total
 * silenciosamente mal. Acá el signo se aplica una vez, en un lugar.
 */
const TIPOS_QUE_RESTAN: ReadonlySet<number> = new Set([60, 61]);

export function restaDelPeriodo(tipoDocCodigo: number): boolean {
  return TIPOS_QUE_RESTAN.has(tipoDocCodigo);
}

export class DocumentoAmbiguo extends Error {
  constructor(
    readonly documento: DocumentoIngestado,
    motivo: string,
  ) {
    super(
      `No se puede identificar de forma única el documento ${documento.tipoDocCodigo}-${documento.folio}: ${motivo}`,
    );
    this.name = 'DocumentoAmbiguo';
  }
}

/**
 * Clave que identifica un documento sin repetirlo si se vuelve a ingestar el
 * mismo período.
 *
 * Normalmente basta `(operación, tipo, folio, RUT de la contraparte)`: el folio
 * es correlativo por emisor, así que el trío es único.
 *
 * **Salvo con contrapartes extranjeras.** Ahí el SII entrega a todas el mismo
 * RUT genérico, de modo que dos proveedores distintos pueden traer el folio 1
 * del mismo tipo y la clave los fusionaría — perdiendo un documento sin que
 * nada lo delate. Para esos casos la razón social entra en la clave, y si
 * tampoco viene, el documento se marca ambiguo en vez de arriesgar la fusión.
 */
export function claveDeIdempotencia(documento: DocumentoIngestado): string {
  const base = [
    documento.empresaRut,
    documento.operacion,
    documento.tipoDocCodigo,
    documento.folio,
    documento.contraparteRut,
  ].join('|');

  if (documento.contraparteRut !== RUT_CONTRAPARTE_EXTRANJERA) return base;

  const nombre = documento.contraparteNombre.trim();
  if (nombre === '') {
    throw new DocumentoAmbiguo(
      documento,
      `la contraparte trae el RUT genérico ${RUT_CONTRAPARTE_EXTRANJERA}, que comparten todas ` +
        'las contrapartes extranjeras, y no viene razón social para distinguirla',
    );
  }

  return `${base}|${normalizar(nombre)}`;
}

/** Sin acentos, sin dobles espacios y en minúsculas, para que la clave no dependa del tipeo. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export class DocumentoInvalido extends Error {
  constructor(readonly problemas: readonly string[]) {
    super(`Documento inválido:\n  ${problemas.join('\n  ')}`);
    this.name = 'DocumentoInvalido';
  }
}

/**
 * Valida lo que el motor de reglas va a dar por cierto. Se hace al ingestar y
 * no al contabilizar: un documento mal formado que llega al motor produce un
 * asiento mal formado, y para entonces ya se perdió de vista de dónde salió.
 */
export function validarDocumento(documento: DocumentoIngestado): DocumentoIngestado {
  const problemas: string[] = [];

  try {
    validarFecha(documento.fecha);
  } catch (error) {
    problemas.push((error as Error).message);
  }

  for (const [campo, valor] of [
    ['montoNeto', documento.montoNeto],
    ['montoExento', documento.montoExento],
    ['montoIva', documento.montoIva],
    ['montoTotal', documento.montoTotal],
  ] as const) {
    try {
      validarMonto(valor);
    } catch (error) {
      problemas.push(`${campo}: ${(error as Error).message}`);
    }
  }

  if (documento.folio.trim() === '') problemas.push('el folio viene vacío');
  if (documento.contraparteRut.trim() === '') problemas.push('la contraparte viene sin RUT');

  if (problemas.length > 0) throw new DocumentoInvalido(problemas);

  // El descuadre del documento no lo rechaza: el SII entrega documentos cuyos
  // componentes no suman el total, y forzarlos acá escondería el problema en
  // lugar de mostrarlo. Se informa para que la regla decida.
  return documento;
}

/** Diferencia entre el total declarado y la suma de sus componentes. Cero es lo normal. */
export function descuadreDelDocumento(documento: DocumentoIngestado): Pesos {
  return documento.montoTotal - (documento.montoNeto + documento.montoExento + documento.montoIva);
}
