import { createHash } from 'crypto';
import { BheEmisionScraper, EmitirBheParams, PrevisualizacionBhe, BheEmitida } from '../scrapers/bheEmision';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';
import { VentanaIdempotencia, claveEstable } from '../idempotenciaEscritura';

export type { EmitirBheParams, PrevisualizacionBhe, BheEmitida, LineaBhe } from '../scrapers/bheEmision';

// Red anti-doble-click de la emisión de BHE: emitir dos veces la misma boleta
// crea DOS documentos tributarios reales (cada uno notifica al receptor). Misma
// clase compartida que el acuse del RCV y el borrador de mipyme; in-process (no
// protege entre instancias), fail-safe (mantiene la reserva salvo error marcado
// seguro — toda la fase de previsualización lo está).
export const ventanaBhe = new VentanaIdempotencia();

export async function emitirBhe(
  registro: EjecutorSesion<SessionManager>,
  rut: string,
  params: EmitirBheParams,
  confirmar: boolean
): Promise<PrevisualizacionBhe | BheEmitida> {
  const correr = () => registro.ejecutar(rut, async sesion =>
    new BheEmisionScraper(new SiiHttpClient(sesion), sesion).emitir(params, confirmar));
  // La previsualización no emite: fuera de la ventana.
  if (!confirmar) return correr();
  // Clave estable: canonicaliza el orden de las claves del objeto, así la ruta y
  // la tool (que arman `params` en órdenes distintos) generan la misma reserva.
  const clave = createHash('sha256').update(claveEstable([rut, params])).digest('hex');
  return ventanaBhe.ejecutar(clave,
    'Esta misma boleta ya se está emitiendo o se emitió hace segundos. No se repite para no '
    + 'duplicar el documento; verificá con la lectura de boletas emitidas antes de reintentar.',
    correr);
}
