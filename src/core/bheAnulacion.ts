import { createHash } from 'crypto';
import { BheAnulacionScraper, CausaAnulacion, AnulacionPrevisualizada, BheAnulada } from '../scrapers/bheAnulacion';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';
import { VentanaIdempotencia, claveEstable } from '../idempotenciaEscritura';

export type { CausaAnulacion, AnulacionPrevisualizada, BheAnulada } from '../scrapers/bheAnulacion';

// Red anti-doble-click de la anulación. Anular dos veces el mismo folio no
// duplica nada (la segunda la rechaza el SII), pero la reserva evita el doble
// POST simultáneo cuya segunda respuesta sería un rechazo confuso para el
// consumidor. Misma clase compartida del resto de la ronda 11.
export const ventanaAnulacion = new VentanaIdempotencia();

export async function anularBhe(
  registro: EjecutorSesion<SessionManager>,
  rut: string,
  folio: number,
  causa: CausaAnulacion,
  confirmar: boolean
): Promise<AnulacionPrevisualizada | BheAnulada> {
  const correr = () => registro.ejecutar(rut, async sesion =>
    new BheAnulacionScraper(new SiiHttpClient(sesion), sesion).anular(folio, causa, confirmar));
  // La previsualización no anula: fuera de la ventana.
  if (!confirmar) return correr();
  // El rut se normaliza (sin puntos, DV en mayúscula): '11.111.111-1' y
  // '11111111-1' son el mismo contribuyente y deben caer en la misma reserva.
  const rutNormal = rut.replace(/\./g, '').toUpperCase();
  const clave = createHash('sha256').update(claveEstable([rutNormal, folio])).digest('hex');
  return ventanaAnulacion.ejecutar(clave,
    `La boleta ${folio} ya se está anulando o se anuló hace segundos. Verificá con la lectura de `
    + 'boletas emitidas antes de reintentar.',
    correr);
}
