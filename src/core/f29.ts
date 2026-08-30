import { F29Scraper, EstadoF29 } from '../scrapers/f29';
import { MisiiScraper } from '../scrapers/misii';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

// El sobre GWT del F29 lleva la unidad operativa del contribuyente en un campo
// de auditoría. En las pruebas el SII respondió igual con cualquier valor, pero
// se manda el real —el de la ficha de Mi SII— para no depender de que lo ignore.
// Es UNA llamada más, y sólo la primera vez por sesión: se cachea por RUT en el
// proceso mientras dura la sesión.
const unidadPorRut = new Map<string, string>();

async function unidadOperativa(sesion: SessionManager, rut: string): Promise<string> {
  const guardada = unidadPorRut.get(rut);
  if (guardada !== undefined) return guardada;
  try {
    const ficha = await new MisiiScraper(new SiiHttpClient(sesion), sesion).datosContribuyente();
    const u = ficha.unidadOperativa ?? '';
    unidadPorRut.set(rut, u);
    return u;
  } catch {
    // Si Mi SII falla, se sigue sin unidad: el F29 respondió igual sin ella.
    unidadPorRut.set(rut, '');
    return '';
  }
}

export async function estadoDeclaracion(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: number
): Promise<EstadoF29> {
  return ejecutor.ejecutar(rut, async sesion => {
    const unidad = await unidadOperativa(sesion, rut);
    return new F29Scraper(new SiiHttpClient(sesion), sesion).estadoDeclaracion(periodo, unidad);
  });
}

export interface CompactoF29 extends EstadoF29 {
  pdf: Buffer;
}

/**
 * El PDF del formulario compacto de un período, junto con el estado. Se resuelve
 * el folio y el codInt del período primero (el PDF los necesita), así que el
 * consumidor pide por PERÍODO y no tiene que conocer el folio.
 */
export async function compacto(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: number
): Promise<CompactoF29> {
  return ejecutor.ejecutar(rut, async sesion => {
    const unidad = await unidadOperativa(sesion, rut);
    const scraper = new F29Scraper(new SiiHttpClient(sesion), sesion);
    const estado = await scraper.estadoDeclaracion(periodo, unidad);
    const pdf = await scraper.pdfCompacto(estado.folio, estado.codInt);
    return { ...estado, pdf };
  });
}
