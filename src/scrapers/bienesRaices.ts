export interface BienRaiz {
  comuna: string;
  rol: string;
  direccion: string;
  destino: string;
  fojas: string;
  numero: string;
  anio: string;
  porcentajeDerechos: number;
  avaluoFiscal: number;
}

export interface ResumenBienesRaices {
  totalBienesRaices: number;
  solicitudesEnCurso: number;
  solicitudesResueltas: number;
  notificaciones: number;
  afectoSobretasa: boolean;
  beneficioAdultoMayor: boolean;
}

export interface BienesRaicesResult {
  resumen: ResumenBienesRaices;
  propiedades: BienRaiz[];
}

// Este archivo conserva SÓLO el contrato del listado. La clase que lo
// implementaba con navegador —abría la SPA en Chromium y parseaba el snapshot
// de accesibilidad— se reemplazó por `bienesRaicesHttp.ts`, que le pide el
// mismo dato al backend REST que la SPA consulta. Las interfaces quedan acá
// porque el scraper HTTP las extiende y porque son el contrato público de
// `/v1/persona/bienes-raices`, que no cambió.
