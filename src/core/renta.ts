import { RentaScraper, EstadoDeclaracionRenta, F22Completo } from '../scrapers/renta';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function estadoDeclaracion(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number
): Promise<EstadoDeclaracionRenta> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new RentaScraper(new SiiHttpClient(sesion), sesion);
    return scraper.estadoDeclaracion(anio);
  });
}

export async function f22Completo(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number,
  folio?: number
): Promise<F22Completo> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new RentaScraper(new SiiHttpClient(sesion), sesion);
    return scraper.f22Completo(anio, folio);
  });
}
