import { MisiiScraper, DatosContribuyente } from '../scrapers/misii';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function datosContribuyente(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<DatosContribuyente> {
  return ejecutor.ejecutar(rut, async sesion =>
    new MisiiScraper(new SiiHttpClient(sesion), sesion).datosContribuyente());
}
