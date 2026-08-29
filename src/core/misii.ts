import { MisiiScraper, FichaCruda, AtributoMisii } from '../scrapers/misii';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

// Versión del parseo, que viaja en cada respuesta. El consumidor la guarda con
// la captura para poder auditar hacia atrás un dato que después resultó estar
// mal: sin ella, una ficha guardada hace tres meses no dice con qué reglas se
// construyó.
export const PARSER_VERSION = 1;

// El régimen es el atributo cuyo código empieza con `14` (el artículo de la Ley
// de la Renta). Relevado: `14D1` = "REGIMEN PRO PYME GENERAL (14D)".
//
// NO se mapea el código a un enum propio acá: sólo se relevó uno, y se sabe que
// existe al menos otro (`14D3`, que una de las empresas relevadas tuvo antes)
// que nadie pudo capturar. Inventar el mapeo del resto sería exactamente el
// error que este repositorio viene evitando. Se entrega el código y la glosa
// tal como los da el SII, y quien clasifique decide con evidencia.
const PREFIJO_REGIMEN = /^14/;

export interface RegimenFicha {
  codigo: string;
  descripcion: string;
  desde: string | null;
  hasta: string | null;
}

export interface FichaContribuyente {
  /** Cuándo se leyó DEL SII. Ver la nota de `capturadoEn` más abajo. */
  capturadoEn: string;
  parserVersion: number;
  /** RUT según el payload del SII, no según el request. */
  rut: string;
  razonSocial: string | null;
  tipoContribuyente: { codigo: string | null; descripcion: string | null };
  subtipoContribuyente: { codigo: string | null; descripcion: string | null };
  fechaConstitucion: string | null;
  fechaInicioActividades: string | null;
  fechaTerminoGiro: string | null;
  segmento: { codigo: string | null; descripcion: string | null };
  regimen: RegimenFicha | null;
  actividades: {
    codigo: number | null;
    giro: string | null;
    categoria: number | null;
    afectaIva: boolean | null;
    desde: string | null;
  }[];
  direcciones: {
    tipo: string | null;
    calle: string | null;
    numero: string | null;
    comuna: string | null;
    region: string | null;
  }[];
  atributos: {
    codigo: string;
    descripcion: string;
    desde: string | null;
    hasta: string | null;
    valor: string | null;
  }[];
  crudo: FichaCruda & { version: number };
}

// El SII usa DOS formatos de fecha en el mismo payload: "2008-05-26 00:00:00.0"
// en `contribuyente` y "01-01-2026" (dd-mm-aaaa) en `atributos`. Se normalizan
// acá y no en cada consumidor: la irregularidad es del SII, es conocida, y
// replicar la conversión en cada cliente multiplica el mismo bug. El payload
// original queda intacto bajo `crudo` para quien necesite auditar.
export function aIso(fecha: string | null | undefined): string | null {
  if (!fecha) return null;
  const conHora = /^(\d{4})-(\d{2})-(\d{2})[ T]/.exec(fecha);
  if (conHora) return `${conHora[1]}-${conHora[2]}-${conHora[3]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  const ddmmaaaa = /^(\d{2})-(\d{2})-(\d{4})$/.exec(fecha);
  if (ddmmaaaa) return `${ddmmaaaa[3]}-${ddmmaaaa[2]}-${ddmmaaaa[1]}`;
  // Un formato que no se reconoce se devuelve tal cual y NO como null: null
  // diría "el SII no informó esta fecha", que es distinto de "el SII la informó
  // y no supimos leerla". El consumidor ve el string raro y puede reclamar.
  return fecha;
}

// Los booleanos del SII son strings: "S"/"N" en los campos de actividad,
// "No"/"Si" en otros. Cualquier otra cosa es null, no `false`: un `false`
// inventado afirma que el SII dijo que no.
export function aBooleano(valor: string | null | undefined): boolean | null {
  if (valor === null || valor === undefined) return null;
  const v = valor.trim().toUpperCase();
  if (v === 'S' || v === 'SI' || v === 'SÍ') return true;
  if (v === 'N' || v === 'NO') return false;
  return null;
}

function aNumero(valor: string | null | undefined): number | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

// El régimen VIGENTE, que es lo único que este portal publica: el payload no
// guarda el anterior. Verificado con un caso real — una empresa que cambió de
// régimen con vigencia 01-01-2026 no deja rastro del que tenía antes.
//
// Por eso `desde` no es decorativo: es el único dato con el que el consumidor
// puede saber para qué períodos vale esta respuesta. Un F29 de un período
// anterior a esa fecha NO se calcula con este régimen.
export function regimenDe(atributos: AtributoMisii[]): RegimenFicha | null {
  const vigentes = atributos.filter(a =>
    PREFIJO_REGIMEN.test(String(a.atrCodigo ?? '')) && !a.fechaTermino);
  const a = vigentes[0];
  if (!a) return null;
  return {
    codigo: String(a.atrCodigo),
    descripcion: String(a.descAtrCodigo ?? ''),
    desde: aIso(a.fechaInicio),
    hasta: aIso(a.fechaTermino),
  };
}

export function normalizar(cruda: FichaCruda, capturadoEn: string): FichaContribuyente {
  const c = cruda.contribuyente;
  return {
    capturadoEn,
    parserVersion: PARSER_VERSION,
    rut: `${c.rut}-${c.dv}`,
    razonSocial: c.razonSocial ?? null,
    tipoContribuyente: {
      codigo: c.tipoContribuyenteCodigo ?? null,
      descripcion: c.tipoContribuyenteDescripcion ?? null,
    },
    subtipoContribuyente: {
      codigo: c.subtipoContribuyenteCodigo ?? null,
      descripcion: c.subtipoContribuyenteDescrip ?? null,
    },
    fechaConstitucion: aIso(c.fechaConstitucion),
    fechaInicioActividades: aIso(c.fechaInicioActividades),
    fechaTerminoGiro: aIso(c.fechaTerminoGiro),
    segmento: {
      codigo: c.segmentoCodigo ?? null,
      descripcion: c.segmentoDescripcion ?? null,
    },
    regimen: regimenDe(cruda.atributos),
    actividades: cruda.actividades.map(a => ({
      codigo: aNumero(a.codigo),
      giro: a.descripcion ?? null,
      categoria: aNumero(a.categoriaTributaria),
      afectaIva: aBooleano(a.afectoIva),
      desde: aIso(a.fechaInicio),
    })),
    direcciones: cruda.direcciones.map(d => ({
      tipo: d.tipoDomicilioDescripcion ?? null,
      calle: d.calle ?? null,
      numero: d.numero ?? null,
      comuna: d.comunaDescripcion ?? null,
      region: d.regionDescripcion ?? null,
    })),
    atributos: cruda.atributos.map(a => ({
      codigo: String(a.atrCodigo),
      descripcion: String(a.descAtrCodigo ?? ''),
      desde: aIso(a.fechaInicio),
      hasta: aIso(a.fechaTermino),
      valor: a.valor ?? null,
    })),
    crudo: { ...cruda, version: PARSER_VERSION },
  };
}

export async function fichaContribuyente(
  registro: EjecutorSesion<SessionManager>,
  rut: string
): Promise<FichaContribuyente> {
  return registro.ejecutar(rut, async sesion => {
    const scraper = new MisiiScraper(new SiiHttpClient(sesion));
    const cruda = await scraper.ficha();
    // `capturadoEn` se sella cuando LLEGA el dato del SII, no cuando se
    // responde. Hoy son casi lo mismo; en cuanto haya caché dejan de serlo, y
    // fechar con la hora de la respuesta afirmaría una confirmación contra el
    // SII que no ocurrió — justo la fecha que el consumidor le muestra al
    // usuario en la ficha.
    return normalizar(cruda, new Date().toISOString());
  });
}
