import { createHash } from 'crypto';
import { BheObservacionScraper, CausaObservacion, ObservacionPrevisualizada, BheObservada } from '../scrapers/bheObservacion';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';
import { VentanaIdempotencia, claveEstable } from '../idempotenciaEscritura';

export type { CausaObservacion, ObservacionPrevisualizada, BheObservada } from '../scrapers/bheObservacion';

// Red anti-doble-click de la observación (irreversible: el comentario queda y
// no se puede borrar). Misma clase compartida de la ronda 11.
export const ventanaObservacion = new VentanaIdempotencia();

export async function observarBhe(
  registro: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number,
  mes: number,
  folio: number,
  causa: CausaObservacion,
  confirmar: boolean,
  emisorRut?: string
): Promise<ObservacionPrevisualizada | BheObservada> {
  const correr = () => registro.ejecutar(rut, async sesion =>
    new BheObservacionScraper(new SiiHttpClient(sesion), sesion).observar(rut, anio, mes, folio, causa, confirmar, emisorRut));
  if (!confirmar) return correr();
  const rutNormal = rut.replace(/\./g, '').toUpperCase();
  // El folio es por emisor y se repite entre períodos: la clave lleva el
  // período y el emisor para no bloquear una observación legítima distinta.
  const clave = createHash('sha256')
    .update(claveEstable([rutNormal, 'observar', anio, mes, folio, emisorRut?.replace(/\./g, '').toUpperCase() ?? '']))
    .digest('hex');
  return ventanaObservacion.ejecutar(clave,
    `La boleta ${folio} ya se está observando o se observó hace segundos. Verificá con la lectura `
    + 'de boletas recibidas antes de reintentar.',
    correr);
}
