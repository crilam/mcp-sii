import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';

// Datos del contribuyente desde "Mi SII" (`misiir.sii.cl/cgi_misii/siihome.cgi`).
//
// La home de Mi SII trae las etiquetas vacías y las llena por JavaScript desde
// un JSON que viaja EMBEBIDO en la misma página: `var DatosCntrNow = {...};`.
// Ahí está todo lo que apigateway expone como "datos del contribuyente":
// identificación, tipo y subtipo, fechas, segmento, glosa de actividad,
// direcciones vigentes y atributos (regímenes, autorizaciones). No hace falta
// ninguna llamada más que la home.
//
// Lo que NO está ahí: representantes, socios y giros. La página los renderiza
// del lado del servidor y para la credencial con que se relevó decían "No
// registra información", así que su forma con datos no se conoce. Quedan fuera
// de esta ronda, dicho en el roadmap.
const HOME = 'https://misiir.sii.cl/cgi_misii/siihome.cgi';
const MARCA = 'DatosCntrNow';
// Segundo bloque embebido en la MISMA página: las actividades económicas del
// contribuyente. No es el catálogo público de códigos que expone
// /v1/contribuyentes/actividades-economicas — son las de ESTE contribuyente,
// con la fecha desde la que las tiene, que el catálogo no puede saber.
const MARCA_ACTECO = 'DatosActeco';

// Versión del parseo, que viaja en la respuesta. El consumidor la guarda con
// cada captura para poder auditar hacia atrás un dato que después resultó estar
// mal: sin ella, una ficha guardada hace tres meses no dice con qué reglas se
// construyó.
export const PARSER_VERSION = 1;

// El régimen es el atributo cuyo código empieza con `14` (el artículo de la Ley
// de la Renta): `14D1` es "REGIMEN PRO PYME GENERAL (14D)".
//
// El código NO se traduce a una clasificación propia. Sólo se relevó uno, y se
// sabe que existe al menos otro (`14D3`) que no se pudo capturar porque el
// portal borra el régimen anterior. Traducir el resto a ciegas daría un régimen
// plausible y equivocado, y de ese dato sale el F29 de quien consume.
const PREFIJO_REGIMEN = /^14/;

export interface DireccionMisii {
  codigo: string;
  tipo: string;
  calle: string;
  numero: string | null;
  departamento: string | null;
  comuna: string;
  comunaCodigo: string;
  region: string;
  tipoPropiedad: string;
  desde: string;
}

export interface AtributoMisii {
  codigo: string;
  descripcion: string;
  valor: string;
  desde: string;
  hasta: string | null;
}

export interface ActividadContribuyente {
  /** Código ACTECO. STRING y no número: varios empiezan con cero. */
  codigo: string;
  giro: string;
  /** Tal como la publica el SII: casi siempre "1" o "2", pero hay letras. */
  categoria: string;
  afectaIva: boolean | null;
  desde: string | null;
}

export interface RegimenContribuyente {
  codigo: string;
  descripcion: string;
  /** Desde cuándo rige. Ver la nota de `regimen` en DatosContribuyente. */
  desde: string | null;
  hasta: string | null;
}

// Lo que trae `DatosCntrNow`. Se separa de la ficha completa para que
// `extraerDatos` siga siendo la función de UN bloque: las actividades viven en
// otro, y mezclarlas obligaba a que cualquier página de prueba trajera los dos.
export interface DatosBase {
  parserVersion: number;
  rut: string;
  razonSocial: string;
  nombres: string | null;
  apellidoPaterno: string | null;
  apellidoMaterno: string | null;
  tipoContribuyente: string;
  subtipoContribuyente: string;
  personaEmpresa: string;
  segmento: string;
  glosaActividad: string;
  email: string | null;
  telefonoMovil: string | null;
  fechaConstitucion: string | null;
  fechaInicioActividades: string | null;
  fechaTerminoGiro: string | null;
  unidadOperativa: string;
  capitalEnterado: number | null;
  capitalPorEnterar: number | null;
  autorizadoDeclararDia20: boolean;
  // El régimen VIGENTE, derivado de `atributos`. Se deriva acá y no en cada
  // consumidor porque de este dato sale el F29 y la regla debe ser una sola.
  //
  // OJO: el portal publica SÓLO el vigente y no guarda el anterior — verificado
  // con una empresa que cambió de régimen. Por eso `desde` no es decorativo: es
  // lo único que dice para qué períodos vale la respuesta. Para un período
  // anterior a esa fecha, éste NO es el régimen que corresponde.
  //
  // `null` significa "no se pudo determinar", nunca un régimen por defecto.
  regimen: RegimenContribuyente | null;
  direcciones: DireccionMisii[];
  atributos: AtributoMisii[];
  // Alertas que Mi SII muestra al contribuyente, tal como vienen: la forma no
  // se conoce con datos (la credencial relevada no tenía ninguna).
  alertas: unknown[];
}

/** La ficha completa: los datos del contribuyente más sus actividades. */
export interface DatosContribuyente extends DatosBase {
  actividades: ActividadContribuyente[];
}

/**
 * Extrae el JSON `DatosCntrNow` de la home. Exportado para testear con una
 * página mínima. Se corta con el propio parser de JSON —`raw_decode`— y no con
 * una regex hasta el `;`: el JSON trae strings con puntos y comas.
 */
export function extraerDatos(html: string): DatosBase {
  // Con o sin espacios alrededor del `=`: una minificación no debe romperlo. Y
  // el `{` tiene que ser el que sigue al `=`, no cualquier `{` posterior: si el
  // valor fuera `null`, engancharía el objeto de otro script.
  const m = new RegExp(`${MARCA}\\s*=\\s*\\{`).exec(html);
  const i = m ? m.index : -1;
  if (i === -1 || !m) {
    // Sin la marca no es la home: es el login, un error del portal o un rediseño.
    // Distinguirlo de "sin datos" importa: un rediseño no puede leerse como un
    // contribuyente vacío.
    throw new SesionDeMisiiCaida(
      'La home de Mi SII no trajo el bloque de datos del contribuyente (DatosCntrNow). '
      + 'La sesión pudo expirar o el portal cambió.');
  }
  const desde = i + m[0].length - 1;
  const crudo = recortarJson(html, desde);
  let d: DatosCrudo;
  try {
    d = JSON.parse(crudo) as DatosCrudo;
  } catch {
    throw new Error('El bloque DatosCntrNow de Mi SII no es JSON válido: cambió el formato.');
  }
  const c = d.contribuyente;
  if (!c || c.codigoError !== 0) {
    throw new Error(
      `Mi SII respondió un error en los datos del contribuyente: ${c?.descripcionError ?? d.descripcionError ?? 'sin detalle'}.`);
  }
  // Sin RUT no hay ficha: un "undefined-undefined" con status 200 sería peor
  // que un error.
  if (!c.rut || !c.dv) {
    throw new Error('El bloque DatosCntrNow de Mi SII no trae el RUT del contribuyente: cambió el formato.');
  }

  const atributos = (d.atributos ?? []).map(a => ({
    codigo: a.atrCodigo ?? '',
    descripcion: a.descAtrCodigo ?? '',
    valor: a.valor ?? '',
    desde: fechaIso(a.fechaInicio) ?? '',
    hasta: fechaIso(a.fechaTermino),
  }));

  return {
    parserVersion: PARSER_VERSION,
    rut: `${c.rut}-${c.dv}`,
    razonSocial: c.razonSocial ?? '',
    nombres: c.nombres ?? null,
    apellidoPaterno: c.apellidoPaterno ?? null,
    apellidoMaterno: c.apellidoMaterno ?? null,
    tipoContribuyente: c.tipoContribuyenteDescripcion ?? '',
    subtipoContribuyente: c.subtipoContribuyenteDescrip ?? '',
    personaEmpresa: c.personaEmpresa ?? '',
    segmento: c.segmentoDescripcion ?? '',
    glosaActividad: c.glosaActividad ?? '',
    email: c.eMail || null,
    telefonoMovil: c.telefonoMovil || null,
    fechaConstitucion: fechaIso(c.fechaConstitucion),
    fechaInicioActividades: fechaIso(c.fechaInicioActividades),
    fechaTerminoGiro: fechaIso(c.fechaTerminoGiro),
    unidadOperativa: c.unidadOperativaDescripcion ?? '',
    capitalEnterado: numero(c.capitalEnterado),
    capitalPorEnterar: numero(c.capitalPorEnterar),
    autorizadoDeclararDia20: /^s/i.test(c.autorizadoDeclararDia20 ?? ''),
    direcciones: (d.direcciones ?? []).map(x => ({
      codigo: x.codigo ?? '',
      tipo: x.tipoDomicilioDescripcion ?? '',
      calle: x.calle ?? '',
      numero: x.numero ?? null,
      departamento: x.departamento ?? null,
      comuna: (x.comunaDescripcion ?? '').trim(),
      comunaCodigo: x.comunaCodigo ?? '',
      region: (x.regionDescripcion ?? '').trim(),
      tipoPropiedad: x.tipoPropiedadDescripcion ?? '',
      desde: fechaIso(x.fechaModiRegistro) ?? '',
    })),
    regimen: regimenDe(atributos),
    atributos,
    alertas: d.alertas ?? [],
  };
}

/**
 * La ficha completa: los dos bloques embebidos de la misma página. Es lo que
 * usa la ruta; `extraerDatos` y `extraerActividades` quedan expuestas por
 * separado porque cada una se prueba con su propia página mínima.
 */
export function extraerFicha(html: string): DatosContribuyente {
  return { ...extraerDatos(html), actividades: extraerActividades(html) };
}

// Los booleanos del SII son strings: "S"/"N" en las actividades. Cualquier otra
// cosa es null y NO false: un false inventado afirma que el SII dijo que no.
function booleano(v: string | null | undefined): boolean | null {
  if (v === null || v === undefined) return null;
  const t = v.trim().toUpperCase();
  if (t === 'S' || t === 'SI' || t === 'SÍ') return true;
  if (t === 'N' || t === 'NO') return false;
  return null;
}

// Extrae el array `DatosActeco`. Mismo criterio que `DatosCntrNow`: sin el
// bloque NO se devuelve una lista vacía —eso afirmaría que el contribuyente no
// tiene actividades— sino un error, porque significa que la página cambió.
export function extraerActividades(html: string): ActividadContribuyente[] {
  const m = new RegExp(`${MARCA_ACTECO}\\s*=\\s*\\[`).exec(html);
  if (!m) {
    throw new Error(
      `La home de Mi SII no trajo el bloque de actividades económicas (${MARCA_ACTECO}): `
      + 'cambió el formato de la página. NO significa que el contribuyente no tenga actividades.');
  }
  const desde = m.index + m[0].length - 1;
  const crudo = recortarArray(html, desde);
  let filas: Record<string, string | null | undefined>[];
  try {
    filas = JSON.parse(crudo) as Record<string, string | null | undefined>[];
  } catch {
    throw new Error(`El bloque ${MARCA_ACTECO} de Mi SII no es JSON válido: cambió el formato.`);
  }
  // Cada elemento trae su propio `codigoError`: el contribuyente sin
  // actividades devuelve un elemento de error con todo en null, que sin filtrar
  // pasaría como una actividad real con código y giro vacíos.
  return filas.filter(f => f.codigo).map(f => ({
    codigo: String(f.codigo),
    giro: f.descripcion ?? '',
    categoria: f.categoriaTributaria ?? '',
    afectaIva: booleano(f.afectoIva),
    desde: fechaIso(f.fechaInicio),
  }));
}

// El régimen VIGENTE. Vigente es "sin término" O "con término todavía por
// venir": descartar cualquier `fechaTermino` devolvía `null` —que el contrato
// define como "no se pudo determinar"— para un régimen que el SII informa
// perfectamente, sólo porque tiene fin agendado.
export function regimenDe(
  atributos: AtributoMisii[], hoy = new Date()
): RegimenContribuyente | null {
  const hoyIso = hoy.toISOString().slice(0, 10);
  const vigentes = atributos.filter(a => {
    if (!PREFIJO_REGIMEN.test(a.codigo)) return false;
    return !a.hasta || a.hasta >= hoyIso;
  });

  // Dos vigentes a la vez no debería pasar, y por eso mismo no se resuelve
  // eligiendo el primero: el orden del array no es un criterio, y de este campo
  // sale el F29. Se falla con los dos códigos a la vista.
  if (vigentes.length > 1) {
    throw new Error(
      `Mi SII informa ${vigentes.length} regímenes vigentes a la vez `
      + `(${vigentes.map(v => v.codigo).join(', ')}): no se puede determinar cuál rige.`);
  }

  const a = vigentes[0];
  return a ? { codigo: a.codigo, descripcion: a.descripcion, desde: a.desde, hasta: a.hasta } : null;
}

// Igual que `recortarJson` pero para un array. Se separan porque el delimitador
// cambia y mezclarlos en una función con parámetro haría más difícil de leer la
// parte que importa: el manejo de strings.
function recortarArray(html: string, desde: number): string {
  let prof = 0;
  let enString = false;
  for (let i = desde; i < html.length; i++) {
    const ch = html[i];
    if (enString) {
      if (ch === '\\') i++;
      else if (ch === '"') enString = false;
      continue;
    }
    if (ch === '"') enString = true;
    else if (ch === '[') prof++;
    else if (ch === ']') { prof--; if (prof === 0) return html.slice(desde, i + 1); }
  }
  throw new Error(`El bloque ${MARCA_ACTECO} de Mi SII está truncado.`);
}

// Devuelve el objeto JSON balanceado que empieza en `desde`, respetando strings
// (con llaves y escapes adentro).
function recortarJson(html: string, desde: number): string {
  let prof = 0;
  let enString = false;
  for (let i = desde; i < html.length; i++) {
    const ch = html[i];
    if (enString) {
      if (ch === '\\') i++;
      else if (ch === '"') enString = false;
      continue;
    }
    if (ch === '"') enString = true;
    else if (ch === '{') prof++;
    else if (ch === '}') { prof--; if (prof === 0) return html.slice(desde, i + 1); }
  }
  throw new Error('El bloque DatosCntrNow de Mi SII está truncado.');
}

// El backend manda los montos como texto SIN separador de miles ("5000"), así
// que no se le quita ningún punto: "1000.5" tiene que seguir siendo 1000.5.
function numero(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// La ficha mezcla dos formatos de fecha —"2008-03-26 00:00:00.0" en el
// contribuyente y "01-01-2026" en los atributos—. Se normalizan a YYYY-MM-DD
// para que el consumidor no tenga que adivinar cuál le tocó.
export function fechaIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})-(\d{2})-(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return t;
}

interface DatosCrudo {
  codigoError?: number;
  descripcionError?: string;
  contribuyente?: Record<string, string | null | undefined> & { codigoError?: number; descripcionError?: string };
  direcciones?: Record<string, string | null | undefined>[];
  atributos?: Record<string, string | null | undefined>[];
  alertas?: unknown[];
}

// La home sin el bloque de datos es el login o un error del portal: la causa
// más común es la sesión del SII caducada. Es una clase propia para que el
// reintento aplique sólo a eso.
class SesionDeMisiiCaida extends Error {}

export class MisiiScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  // Sin invalidar la sesión, `autenticadoHasta` la sigue dando por buena unas
  // dos horas y cada llamada repetiría el login hasta reiniciar el proceso.
  // Mismo patrón que bienes raíces y BHE: se reintenta UNA vez con sesión nueva.
  async datosContribuyente(): Promise<DatosContribuyente> {
    try {
      return await this.intentar();
    } catch (e) {
      if (!(e instanceof SesionDeMisiiCaida)) throw e;
      this.session.invalidate();
      return this.intentar();
    }
  }

  private async intentar(): Promise<DatosContribuyente> {
    this.session.assertPuedeEntregarCookieJar();
    const html = await this.http.get(HOME, undefined, { guardarCookies: true });
    return extraerFicha(html);
  }
}
