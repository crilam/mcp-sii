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
// consumidor, no dos actos deliberados. La clave se RESERVA de forma síncrona
// —antes de tocar el SII— para que dos requests concurrentes (el doble-click
// real, dos POST casi simultáneos) no pasen ambos el chequeo: el segundo ve la
// reserva del primero. NO se persiste: es una salvaguarda de último momento en
// el proceso, no una garantía transaccional (el SII es la autoridad).
const VENTANA_MS = 60_000;
// clave → timestamp de la reserva. Mientras una clave esté acá (reservada o ya
// cursada), un segundo acuse idéntico se rechaza.
const enCurso = new Map<string, number>();

function claveDe(rut: string, documentos: DocumentoAcuse[], evento: string): string {
  const docs = documentos.map(d => `${d.rutEmisor}|${d.tipoDoc}|${d.folio}`).sort().join(';');
  return createHash('sha256').update(`${rut}|${evento}|${docs}`).digest('hex');
}

function purgar(ahora: number) {
  for (const [k, ts] of enCurso) if (ahora - ts > VENTANA_MS) enCurso.delete(k);
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
  // Una simulación no muta nada: no toca la ventana de idempotencia.
  if (!confirmar) {
    return registro.ejecutar(rut, async sesion =>
      new RcvEscrituraScraper(new SiiHttpClient(sesion), sesion).acusar(documentos, evento, false));
  }

  const clave = claveDe(rut, documentos, evento);
  purgar(Date.now());
  if (enCurso.has(clave)) {
    // Otro request con este mismo acuse está en vuelo o se cursó hace instantes:
    // no se dispara un segundo acto contra el SII.
    throw new LimitacionConocida(
      `Este acuse ("${evento}" sobre ${documentos.length} documento(s)) ya está en curso o se cursó hace segundos. `
      + 'No se repite para no duplicar el acto; verificá en el RCV si ya quedó cursado antes de reintentar.');
  }
  // Reserva SÍNCRONA: entre este set y el await no hay punto de suspensión, así
  // que un segundo request concurrente ya la encuentra.
  enCurso.set(clave, Date.now());

  try {
    const resultado = await registro.ejecutar(rut, async sesion =>
      new RcvEscrituraScraper(new SiiHttpClient(sesion), sesion).acusar(documentos, evento, true));
    // Cursado: la reserva se refresca y bloquea repeticiones el resto de la ventana.
    enCurso.set(clave, Date.now());
    return resultado;
  } catch (e) {
    // Sólo se libera la reserva si el fallo fue ANTES de mandar el POST (evento
    // inválido, sesión, etc.): ahí no se cursó nada y un reintento es seguro. Si
    // el POST ya salió (`postEnvio`), el acto pudo quedar cursado aunque acá
    // falle —timeout de red, o un 100 "cursó con reparos"—, y liberar la reserva
    // habilitaría un segundo acto: se MANTIENE la ventana completa.
    if (!(e as { postEnvio?: boolean }).postEnvio) enCurso.delete(clave);
    throw e;
  }
}

/** Limpia la ventana de idempotencia. Sólo para tests. */
export function _resetIdempotencia(): void {
  enCurso.clear();
}
