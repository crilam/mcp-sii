import { BienesRaicesScraper, BienesRaicesResult } from '../scrapers/bienesRaices';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function listBienesRaices(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<BienesRaicesResult> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BienesRaicesScraper(sesion.obtenerBrowser(), sesion);
    return scraper.listBienesRaices();
  });
}
