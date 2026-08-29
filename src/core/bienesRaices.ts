import {
  BienesRaicesHttpScraper, BienesRaicesHttpResult, Comuna, Copropietario, SolicitudDocumento,
  PropiedadConsultada, RolPredio, TipoCertificadoAvaluo,
} from '../scrapers/bienesRaicesHttp';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

// Todo bienes raíces va por la API HTTP del portal, sin navegador. El listado
// antes levantaba Chromium y parseaba el snapshot de accesibilidad de la SPA;
// ahora pide el mismo dato al backend que la SPA consulta. Misma respuesta,
// más los códigos del catastro que hacen falta para las rutas nuevas.
function scraperDe(sesion: SessionManager): BienesRaicesHttpScraper {
  return new BienesRaicesHttpScraper(new SiiHttpClient(sesion), sesion);
}

export async function listBienesRaices(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<BienesRaicesHttpResult> {
  return ejecutor.ejecutar(rut, async sesion => scraperDe(sesion).listBienesRaices());
}

export async function comunas(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<Comuna[]> {
  return ejecutor.ejecutar(rut, async sesion => scraperDe(sesion).comunas());
}

export async function multipropietarios(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  rol: RolPredio
): Promise<Copropietario[]> {
  return ejecutor.ejecutar(rut, async sesion => scraperDe(sesion).multipropietarios(rol));
}

export async function solicitudes(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<SolicitudDocumento[]> {
  return ejecutor.ejecutar(rut, async sesion => scraperDe(sesion).solicitudes());
}

export async function consultarPorRol(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  rol: RolPredio
): Promise<PropiedadConsultada[]> {
  return ejecutor.ejecutar(rut, async sesion => scraperDe(sesion).consultarPorRol(rol));
}

export async function certificadoAvaluo(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  bienes: (RolPredio & { ultimoEacAplicado: number })[],
  tipo: TipoCertificadoAvaluo
): Promise<Buffer> {
  return ejecutor.ejecutar(rut, async sesion => scraperDe(sesion).certificadoAvaluo(bienes, tipo));
}

export async function descargarDocumento(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  url: string
): Promise<Buffer> {
  return ejecutor.ejecutar(rut, async sesion => scraperDe(sesion).descargarDocumento(url));
}
