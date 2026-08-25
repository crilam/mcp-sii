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

// El informe anual de RECIBIDAS es un CGI aparte, y no es el mismo dato agregado
// que el mensual de recibidas: ahí el SII muestra una columna "retención
// contribuyente" que el informe mensual no trae (07/2026 informa 19.063 en el
// anual y "Retenido 0" en las cuatro boletas del mensual). O sea que este
// resumen no se puede reconstruir sumando `listRecibidas`.
export async function resumenRecibidas(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number
): Promise<InformeAnualBhe> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BheScraper(new SiiHttpClient(sesion), sesion);
    return scraper.informeAnual(anio, true);
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

// Devuelve el PDF de una boleta como bytes. Quien expone el resultado decide
// cómo transportarlo (el adaptador REST lo manda en base64); el core no se
// mete en eso.
export async function pdf(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  codigoBarras: string,
  // Mismo default que el schema, para que "emitida" no dependa de que cada
  // llamador se acuerde de pasar false.
  recibida = false
): Promise<Buffer> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BheScraper(new SiiHttpClient(sesion), sesion);
    return scraper.pdfBoleta(codigoBarras, recibida);
  });
}
