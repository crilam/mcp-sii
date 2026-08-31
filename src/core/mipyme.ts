import { createHash } from 'crypto';
import { MipymeHttpScraper, BorradorMipyme, FiltrosDteEmitidos, DteEmitidosResult, FiltrosDteRecibidos, DteRecibidosResult, EmitirDteParams, PrevisualizacionDte, DteEmitido, BorradorGuardado } from '../scrapers/mipymeHttp';
import { SiiHttpClient } from '../http';
import { SessionManager, Empresa } from '../session';
import { EjecutorSesion } from '../registroSesiones';
import { VentanaIdempotencia } from '../idempotenciaEscritura';

// Red anti-doble-click del guardado de borrador: como el SII no devuelve el id
// de un borrador nuevo, dos llamadas idénticas grabarían dos borradores sin que
// el consumidor lo note. Sólo protege el grabado real (confirmar:true).
const ventanaBorrador = new VentanaIdempotencia();
export function _resetIdempotenciaBorrador(): void { ventanaBorrador._reset(); }

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

export async function listDteRecibidos(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  filtros: FiltrosDteRecibidos
): Promise<DteRecibidosResult> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.listDteRecibidos(filtros);
  });
}

export async function dtePdf(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  codigo: string,
  empresaRut?: string
): Promise<Buffer> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.dtePdf(codigo, empresaRut);
  });
}

export async function listBorradores(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  empresaRut?: string
): Promise<BorradorMipyme[]> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.listBorradores(empresaRut);
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

// Guarda un DTE como BORRADOR (reversible, no lo emite). Con confirmar:false
// simula; con true graba. `borradorId` edita un borrador existente.
export async function guardarBorrador(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  params: EmitirDteParams,
  confirmar: boolean,
  borradorId?: string
): Promise<BorradorGuardado> {
  const grabar = () => ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.guardarBorrador(params, confirmar, borradorId);
  });
  // La simulación no muta: no toca la ventana de idempotencia. El grabado sí.
  if (!confirmar) return grabar();
  const clave = createHash('sha256')
    .update(JSON.stringify([rut, borradorId ?? '', params]))
    .digest('hex');
  return ventanaBorrador.ejecutar(clave,
    'Este borrador ya se está guardando o se guardó hace segundos. No se repite para no '
    + 'duplicarlo; verificá con list-borradores antes de reintentar.',
    grabar);
}
