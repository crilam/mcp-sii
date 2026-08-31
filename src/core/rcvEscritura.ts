import { createHash } from 'crypto';
import { RcvEscrituraScraper, EventoAcuse, DocumentoAcuse, ResultadoAcuse } from '../scrapers/rcvEscritura';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';
import { LimitacionConocida } from '../erroresConsulta';

export type { EventoAcuse, DocumentoAcuse, ResultadoAcuse } from '../scrapers/rcvEscritura';

export async function eventosAcuse(
  registro: EjecutorSesion<SessionManager>,
  rut: string
): Promise<EventoAcuse[]> {
  return registro.ejecutar(rut, async sesion =>
    new RcvEscrituraScraper(new SiiHttpClient(sesion), sesion).eventosAcuse());
}

// Red anti-doble-click: una MISMA escritura (mismo RUT, documentos y evento)
// ejecutada dos veces en una ventana corta es casi siempre un reintento del
// consumidor, no dos actos deliberados. Se recuerda el resultado por
// `VENTANA_MS` y se devuelve el mismo en vez de cursar de nuevo. NO se persiste:
// es una salvaguarda de último momento en el proceso, no una garantía
// transaccional (el SII es la autoridad). Sólo se recuerdan ÉXITOS ejecutados.
const VENTANA_MS = 60_000;
const ejecutadasRecientes = new Map<string, { ts: number; resultado: ResultadoAcuse }>();

function claveDe(rut: string, documentos: DocumentoAcuse[], evento: string): string {
  const docs = documentos.map(d => `${d.rutEmisor}|${d.tipoDoc}|${d.folio}`).sort().join(';');
  return createHash('sha256').update(`${rut}|${evento}|${docs}`).digest('hex');
}

function purgar(ahora: number) {
  for (const [k, v] of ejecutadasRecientes) if (ahora - v.ts > VENTANA_MS) ejecutadasRecientes.delete(k);
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
  const ahora = Date.now();
  purgar(ahora);
  const clave = claveDe(rut, documentos, evento);

  if (confirmar) {
    const previa = ejecutadasRecientes.get(clave);
    if (previa) {
      // Ya se cursó este mismo acuse hace instantes: no se repite el acto contra
      // el SII. Se devuelve el resultado anterior, marcado para que el consumidor
      // sepa que no se ejecutó una segunda vez.
      throw new LimitacionConocida(
        `Este acuse ("${evento}" sobre ${documentos.length} documento(s)) ya se cursó hace unos segundos. `
        + 'No se repite para no duplicar el acto; si de verdad querés cursarlo otra vez, esperá un minuto.');
    }
  }

  const resultado = await registro.ejecutar(rut, async sesion =>
    new RcvEscrituraScraper(new SiiHttpClient(sesion), sesion).acusar(documentos, evento, confirmar));

  if (resultado.ejecutado) ejecutadasRecientes.set(clave, { ts: Date.now(), resultado });
  return resultado;
}
