import { RcvScraper, OperacionRcv, ResumenRcv, DetalleRcv } from '../scrapers/rcv';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

// Tipado contra la interfaz EjecutorSesion, no contra RegistroSesiones
// concreto: así el adaptador REST puede pasar un ejecutor "de un solo uso"
// (ver ejecutorPassThroughDe en rest/rutas/rcv.ts) sin que este core lo note.
export async function resumen(
  registro: EjecutorSesion<SessionManager>,
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
  registro: EjecutorSesion<SessionManager>,
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
