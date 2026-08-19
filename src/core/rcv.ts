import { RcvScraper, OperacionRcv, ResumenRcv, DetalleRcv } from '../scrapers/rcv';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';

export async function resumen(
  registro: RegistroSesiones<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionRcv,
  empresaRut?: string
): Promise<ResumenRcv> {
  return registro.ejecutar(rut, async sesion => {
    const scraper = new RcvScraper(new SiiHttpClient(sesion), sesion);
    return scraper.resumen(periodo, operacion, empresaRut);
  });
}

export async function detalle(
  registro: RegistroSesiones<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionRcv,
  tipoDocCodigo: number,
  empresaRut?: string
): Promise<DetalleRcv> {
  return registro.ejecutar(rut, async sesion => {
    const scraper = new RcvScraper(new SiiHttpClient(sesion), sesion);
    return scraper.detalle(periodo, operacion, tipoDocCodigo, empresaRut);
  });
}
