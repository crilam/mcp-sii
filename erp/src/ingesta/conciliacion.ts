/**
 * Conciliación entre lo que trae el SII y lo que ya está registrado.
 *
 * Reingestar un período tiene que ser seguro: es la operación normal cuando el
 * SII incorpora documentos con atraso, y va a pasar todos los meses.
 */
import {
  type DocumentoIngestado,
  DocumentoAmbiguo,
  claveDeIdempotencia,
} from './documento';

/** Lo que quedó guardado de un documento ya ingestado, para poder compararlo. */
export interface DocumentoRegistrado {
  readonly clave: string;
  readonly montoNeto: number;
  readonly montoExento: number;
  readonly montoIva: number;
  readonly montoTotal: number;
  /** Número del asiento que lo contabilizó, si ya se aprobó. */
  readonly asientoNumero?: number;
}

export interface DocumentoCambiado {
  readonly documento: DocumentoIngestado;
  readonly registrado: DocumentoRegistrado;
  readonly diferencias: readonly string[];
}

export interface Conciliacion {
  /** Nunca vistos. Van al motor de reglas. */
  readonly nuevos: readonly DocumentoIngestado[];
  /** Ya registrados y sin cambios. No se hace nada con ellos. */
  readonly sinCambios: readonly DocumentoIngestado[];
  /**
   * Ya registrados pero con montos distintos. **No se contabilizan solos**: si
   * el original ya está en el mayor, corregirlo exige una reversión, y eso es
   * una decisión de quien lleva la contabilidad.
   */
  readonly cambiados: readonly DocumentoCambiado[];
  /** Los que no se pueden identificar de forma única. */
  readonly ambiguos: readonly { documento: DocumentoIngestado; motivo: string }[];
  /** Repetidos dentro del mismo lote entrante. */
  readonly duplicadosEnElLote: readonly DocumentoIngestado[];
}

export function conciliar(
  entrantes: readonly DocumentoIngestado[],
  registrados: readonly DocumentoRegistrado[],
): Conciliacion {
  const porClave = new Map(registrados.map((r) => [r.clave, r]));

  const nuevos: DocumentoIngestado[] = [];
  const sinCambios: DocumentoIngestado[] = [];
  const cambiados: DocumentoCambiado[] = [];
  const ambiguos: { documento: DocumentoIngestado; motivo: string }[] = [];
  const duplicadosEnElLote: DocumentoIngestado[] = [];

  const vistasEnElLote = new Set<string>();

  for (const documento of entrantes) {
    let clave: string;
    try {
      clave = claveDeIdempotencia(documento);
    } catch (error) {
      if (error instanceof DocumentoAmbiguo) {
        ambiguos.push({ documento, motivo: error.message });
        continue;
      }
      throw error;
    }

    // El mismo documento dos veces en la misma respuesta del SII no es normal,
    // pero contabilizarlo dos veces sí sería un problema.
    if (vistasEnElLote.has(clave)) {
      duplicadosEnElLote.push(documento);
      continue;
    }
    vistasEnElLote.add(clave);

    const registrado = porClave.get(clave);
    if (registrado === undefined) {
      nuevos.push(documento);
      continue;
    }

    const diferencias = compararMontos(documento, registrado);
    if (diferencias.length === 0) sinCambios.push(documento);
    else cambiados.push({ documento, registrado, diferencias });
  }

  return { nuevos, sinCambios, cambiados, ambiguos, duplicadosEnElLote };
}

function compararMontos(
  documento: DocumentoIngestado,
  registrado: DocumentoRegistrado,
): readonly string[] {
  const diferencias: string[] = [];
  const campos = [
    ['neto', documento.montoNeto, registrado.montoNeto],
    ['exento', documento.montoExento, registrado.montoExento],
    ['IVA', documento.montoIva, registrado.montoIva],
    ['total', documento.montoTotal, registrado.montoTotal],
  ] as const;

  for (const [nombre, ahora, antes] of campos) {
    if (ahora !== antes) {
      diferencias.push(`${nombre}: estaba ${antes}, ahora ${ahora}`);
    }
  }

  return diferencias;
}
