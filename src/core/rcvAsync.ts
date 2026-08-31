import { RcvAsyncScraper, SolicitudAsyncRcv, DetalleAsyncRcv } from '../scrapers/rcvAsync';
import { OperacionRcv } from '../scrapers/rcv';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

// Cierre de R1: descarga asíncrona del detalle del RCV, para volúmenes que el
// detalle síncrono no alcanza. El servicio NO persiste nada — el SII es el dueño
// del estado de la solicitud y el consumidor hace su propio polling.

export async function solicitar(
  registro: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionRcv,
  tipoDocCodigo: number,
  empresaRut?: string
): Promise<SolicitudAsyncRcv> {
  return registro.ejecutar(rut, async sesion =>
    new RcvAsyncScraper(new SiiHttpClient(sesion), sesion).solicitar(periodo, operacion, tipoDocCodigo, empresaRut));
}

export async function estado(
  registro: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionRcv,
  tipoDocCodigo: number,
  empresaRut?: string
): Promise<SolicitudAsyncRcv[]> {
  return registro.ejecutar(rut, async sesion =>
    new RcvAsyncScraper(new SiiHttpClient(sesion), sesion).estado(periodo, operacion, tipoDocCodigo, empresaRut));
}

export async function detalle(
  registro: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionRcv,
  tipoDocCodigo: number,
  empresaRut?: string
): Promise<DetalleAsyncRcv> {
  return registro.ejecutar(rut, async sesion =>
    new RcvAsyncScraper(new SiiHttpClient(sesion), sesion).detalle(periodo, operacion, tipoDocCodigo, empresaRut));
}
