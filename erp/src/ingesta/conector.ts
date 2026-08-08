/**
 * Traduce lo que devuelve el MCP del SII a documentos que el motor de reglas
 * entiende.
 *
 * Esta es la única capa que conoce la forma del RCV. Si el SII cambia un campo,
 * cambia acá y no en el motor ni en las reglas.
 */
import type { DetalleRcv, FilaDetalleRcv } from '../../../src/scrapers/rcv';

import {
  type DocumentoIngestado,
  type Operacion,
  validarDocumento,
} from './documento';

export class DocumentoNoImputable extends Error {
  constructor(
    readonly fila: FilaDetalleRcv,
    motivo: string,
  ) {
    super(`El documento folio ${fila.folio} no se puede imputar: ${motivo}`);
    this.name = 'DocumentoNoImputable';
  }
}

export interface Traduccion {
  readonly documentos: readonly DocumentoIngestado[];
  /**
   * Filas que llegaron pero no se pueden contabilizar. Van a la vista con su
   * motivo, en vez de descartarse: un documento que desaparece en silencio es
   * un descuadre que nadie va a poder explicar después.
   */
  readonly noImputables: readonly { fila: FilaDetalleRcv; motivo: string }[];
}

function operacionDe(operacion: DetalleRcv['operacion']): Operacion {
  return operacion === 'COMPRA' ? 'compra' : 'venta';
}

export function traducirDetalleRcv(detalle: DetalleRcv): Traduccion {
  const documentos: DocumentoIngestado[] = [];
  const noImputables: { fila: FilaDetalleRcv; motivo: string }[] = [];

  for (const fila of detalle.documentos) {
    try {
      documentos.push(traducirFila(detalle, fila));
    } catch (error) {
      if (error instanceof DocumentoNoImputable) {
        noImputables.push({ fila, motivo: error.message });
        continue;
      }
      // Un documento mal formado tampoco frena al resto del período.
      noImputables.push({ fila, motivo: (error as Error).message });
    }
  }

  return { documentos, noImputables };
}

function traducirFila(detalle: DetalleRcv, fila: FilaDetalleRcv): DocumentoIngestado {
  // Sin fecha no hay período al cual imputar. Inventarla usando el período de
  // la consulta metería el documento en un mes que el SII no afirmó, y quedaría
  // indistinguible de uno con fecha real.
  if (fila.fechaEmision === null || fila.fechaEmision.trim() === '') {
    throw new DocumentoNoImputable(fila, 'el SII no informó fecha de emisión');
  }

  return validarDocumento({
    empresaRut: detalle.empresaRut,
    operacion: operacionDe(detalle.operacion),
    tipoDocCodigo: detalle.tipoDocCodigo,
    folio: String(fila.folio),
    fecha: fila.fechaEmision.slice(0, 10),
    contraparteRut: fila.contraparteRut,
    contraparteTipoId: fila.contraparteTipoId,
    contraparteIdExtranjero: fila.contraparteIdExtranjero,
    contraparteNombre: fila.contraparteNombre,
    montoNeto: fila.montoNeto,
    montoExento: fila.montoExento,
    montoIva: fila.montoIva,
    montoTotal: fila.montoTotal,
    ...(fila.referenciaFolio !== null ? { referenciaFolio: String(fila.referenciaFolio) } : {}),
    ...(fila.referenciaTipoDoc !== null ? { referenciaTipoDoc: fila.referenciaTipoDoc } : {}),
  });
}
