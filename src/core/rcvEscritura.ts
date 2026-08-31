import { createHash } from 'crypto';
import { RcvEscrituraScraper, EventoAcuse, DocumentoAcuse, ResultadoAcuse } from '../scrapers/rcvEscritura';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';
import { VentanaIdempotencia } from '../idempotenciaEscritura';

export type { EventoAcuse, DocumentoAcuse, ResultadoAcuse } from '../scrapers/rcvEscritura';

export async function eventosAcuse(
  registro: EjecutorSesion<SessionManager>,
  rut: string
): Promise<EventoAcuse[]> {
  return registro.ejecutar(rut, async sesion =>
    new RcvEscrituraScraper(new SiiHttpClient(sesion), sesion).eventosAcuse());
}

// Red anti-doble-click, compartida con el borrador de mipyme (misma clase). Un
// acuse repetido en la ventana se rechaza; la reserva es fail-safe (se mantiene
// salvo error marcado seguro) y no expira mientras la operación esté en vuelo.
export const ventanaAcuse = new VentanaIdempotencia();

function claveDe(rut: string, documentos: DocumentoAcuse[], evento: string): string {
  const docs = documentos.map(d => `${d.rutEmisor}|${d.tipoDoc}|${d.folio}`).sort().join(';');
  return createHash('sha256').update(`${rut}|${evento}|${docs}`).digest('hex');
}

/**
 * Acusa recibo de documentos del RCV. Con `confirmar:false` (default) simula.
 * Con `true` cursa el acto real, protegido por la ventana de idempotencia.
 */
export async function acusar(
  registro: EjecutorSesion<SessionManager>,
  rut: string,
  documentos: DocumentoAcuse[],
  evento: string,
  confirmar: boolean
): Promise<ResultadoAcuse> {
  const cursar = () => registro.ejecutar(rut, async sesion =>
    new RcvEscrituraScraper(new SiiHttpClient(sesion), sesion).acusar(documentos, evento, confirmar));
  // Una simulación no muta nada: no toca la ventana de idempotencia.
  if (!confirmar) return cursar();
  return ventanaAcuse.ejecutar(claveDe(rut, documentos, evento),
    `Este acuse ("${evento}" sobre ${documentos.length} documento(s)) ya está en curso o se cursó hace segundos. `
    + 'No se repite para no duplicar el acto; verificá en el RCV si ya quedó cursado antes de reintentar.',
    cursar);
}
