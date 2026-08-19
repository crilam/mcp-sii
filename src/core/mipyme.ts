import { MipymeHttpScraper, FiltrosDteEmitidos, DteEmitidosResult, EmitirDteParams, PrevisualizacionDte, DteEmitido } from '../scrapers/mipymeHttp';
import { SiiHttpClient } from '../http';
import { SessionManager, Empresa } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function listEmpresas(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<Empresa[]> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.listEmpresas();
  });
}

export async function listDteEmitidos(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  filtros: FiltrosDteEmitidos
): Promise<DteEmitidosResult> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.listDteEmitidos(filtros);
  });
}

export async function emitirDte(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  params: EmitirDteParams,
  confirmar: boolean
): Promise<PrevisualizacionDte | DteEmitido> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.emitirDte(params, confirmar);
  });
}
