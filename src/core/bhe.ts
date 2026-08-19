import { BheScraper, InformeAnualBhe, BoletaBhe } from '../scrapers/bhe';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function resumen(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number
): Promise<InformeAnualBhe> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BheScraper(new SiiHttpClient(sesion), sesion);
    return scraper.informeAnual(anio);
  });
}

export async function listEmitidas(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number,
  mes: number
): Promise<BoletaBhe[]> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BheScraper(new SiiHttpClient(sesion), sesion);
    return scraper.informeMensual(anio, mes, false);
  });
}

export async function listRecibidas(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number,
  mes: number
): Promise<BoletaBhe[]> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BheScraper(new SiiHttpClient(sesion), sesion);
    return scraper.informeMensual(anio, mes, true);
  });
}
