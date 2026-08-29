import {
  DteVerificacionScraper, DteAVerificar, DteAVerificarContenido, ResultadoValidez, ResultadoContenido,
} from '../scrapers/dteVerificacion';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function validez(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  d: DteAVerificar
): Promise<ResultadoValidez> {
  return ejecutor.ejecutar(rut, async sesion =>
    new DteVerificacionScraper(new SiiHttpClient(sesion), sesion).validez(d));
}

export async function contenido(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  d: DteAVerificarContenido
): Promise<ResultadoContenido> {
  return ejecutor.ejecutar(rut, async sesion =>
    new DteVerificacionScraper(new SiiHttpClient(sesion), sesion).contenido(d));
}
