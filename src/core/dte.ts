import { DteScraper, OperacionDte, ListadoDte, DocumentoDte } from '../scrapers/dte';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export interface OpcionesListadoDte {
  empresaRut?: string;
  tipoDocCodigo?: number;
  seccion?: string;
  contraparteRut?: string;
  limit?: number;
  incluirDetalle?: boolean;
}

export async function listar(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionDte,
  opciones: OpcionesListadoDte
): Promise<ListadoDte> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new DteScraper(new SiiHttpClient(sesion), sesion);
    return scraper.listar(periodo, operacion, opciones);
  });
}

export async function getDocumento(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionDte,
  tipoDocCodigo: number,
  folio: number,
  empresaRut?: string
): Promise<DocumentoDte> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new DteScraper(new SiiHttpClient(sesion), sesion);
    return scraper.getDocumento(periodo, operacion, tipoDocCodigo, folio, empresaRut);
  });
}
