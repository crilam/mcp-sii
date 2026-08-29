import { SiiHttpClient } from '../http';

// Ficha del contribuyente en el portal privado del SII ("Mi información
// tributaria"). Relevado el 2026-08-29 contra dos empresas reales; ver
// docs/superpowers/specs/2026-08-29-ronda-8-misii-relevamiento.md.
//
// A diferencia del resto del portal legacy, esta página NO hay que scrapearla:
// embebe tres payloads JSON ya serializados por el servidor. El parseo es
// `JSON.parse` sobre una asignación, no regex sobre rótulos, y eso cambia el
// modo de falla — el riesgo pasa de "devuelve datos plausibles y equivocados" a
// "no encuentra la variable", que es ruidoso y por lo tanto detectable.
const URL_HOME = 'https://misiir.sii.cl/cgi_misii/siihome.cgi';

export interface ContribuyenteMisii {
  rut: string;
  dv: string;
  razonSocial: string | null;
  nombres: string | null;
  apellidoPaterno: string | null;
  apellidoMaterno: string | null;
  tipoContribuyenteCodigo: string | null;
  tipoContribuyenteDescripcion: string | null;
  subtipoContribuyenteCodigo: string | null;
  subtipoContribuyenteDescrip: string | null;
  fechaConstitucion: string | null;
  fechaInicioActividades: string | null;
  fechaTerminoGiro: string | null;
  eMail: string | null;
  telefonoMovil: string | null;
  segmentoCodigo: string | null;
  segmentoDescripcion: string | null;
  personaEmpresa: string | null;
  glosaActividad: string | null;
  capitalEnterado: string | null;
  capitalPorEnterar: string | null;
  unidadOperativaCodigo: string | null;
  unidadOperativaDescripcion: string | null;
  autorizadoDeclararDia20: string | null;
  declaraTG: string | null;
  [campo: string]: unknown;
}

export interface AtributoMisii {
  atrCodigo: string;
  descAtrCodigo: string;
  fechaInicio: string | null;
  fechaTermino: string | null;
  valor: string | null;
  [campo: string]: unknown;
}

export interface DireccionMisii {
  codigo: string | null;
  tipoDomicilioCodigo: string | null;
  tipoDomicilioDescripcion: string | null;
  calle: string | null;
  numero: string | null;
  bloque: string | null;
  departamento: string | null;
  villaPoblacion: string | null;
  ciudad: string | null;
  comunaCodigo: string | null;
  comunaDescripcion: string | null;
  regionCodigo: string | null;
  regionDescripcion: string | null;
  [campo: string]: unknown;
}

export interface ActividadMisii {
  codigo: string | null;
  descripcion: string | null;
  categoriaTributaria: string | null;
  afectoIva: string | null;
  fechaInicio: string | null;
  [campo: string]: unknown;
}

/** Los tres payloads tal como los sirve el portal, sin normalizar. */
export interface FichaCruda {
  contribuyente: ContribuyenteMisii;
  direcciones: DireccionMisii[];
  atributos: AtributoMisii[];
  actividades: ActividadMisii[];
  alertas: unknown[];
}

// Una variable ausente es ERROR, nunca "sin datos". Es la regla central de este
// scraper: si el SII renombra la variable o cambia de esta técnica a XHR,
// devolver una ficha vacía afirmaría que el contribuyente no tiene razón social
// ni actividades ni régimen — una afirmación falsa sobre datos del SII, hecha
// por nosotros. Que reviente es lo que queremos.
export class EstructuraMisiiDesconocida extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
  }
}

/**
 * Extrae `nombre = {...}` o `nombre = [...]` del HTML contando llaves
 * balanceadas.
 *
 * No se usa un regex no-greedy hasta el primer `}`: los payloads tienen objetos
 * anidados (`contribuyente`, cada dirección) y cortar en el primer cierre daría
 * un JSON truncado — que `JSON.parse` rechaza, pero con un error que apunta al
 * lugar equivocado. Contar llaves corta donde termina de verdad.
 *
 * Las llaves dentro de strings del propio JSON no se cuentan: una razón social
 * con `{` es rara pero posible, y el costo de contemplarlo es un `if`.
 */
export function extraerVariable(html: string, nombre: string): string | null {
  const asignacion = new RegExp(`\\b${nombre}\\s*=\\s*([{[])`);
  const m = asignacion.exec(html);
  if (!m) return null;

  const abre = m[1];
  const cierra = abre === '{' ? '}' : ']';
  const desde = m.index + m[0].length - 1;

  let profundidad = 0;
  let enString = false;
  let escapado = false;

  for (let i = desde; i < html.length; i++) {
    const c = html[i];

    if (enString) {
      if (escapado) escapado = false;
      else if (c === '\\') escapado = true;
      else if (c === '"') enString = false;
      continue;
    }

    if (c === '"') { enString = true; continue; }
    if (c === abre) profundidad++;
    else if (c === cierra) {
      profundidad--;
      if (profundidad === 0) return html.slice(desde, i + 1);
    }
  }
  return null;
}

function parsear<T>(html: string, nombre: string): T {
  const crudo = extraerVariable(html, nombre);
  if (crudo === null) {
    throw new EstructuraMisiiDesconocida(
      `No se encontró la variable ${nombre} en el portal del SII: cambió la estructura de la página. ` +
      'Esto NO significa que el contribuyente no tenga datos.'
    );
  }
  try {
    return JSON.parse(crudo) as T;
  } catch (e) {
    throw new EstructuraMisiiDesconocida(
      `La variable ${nombre} del portal del SII no es JSON válido: ${(e as Error).message}`
    );
  }
}

export function parsearFicha(html: string): FichaCruda {
  const now = parsear<{
    contribuyente?: ContribuyenteMisii;
    direcciones?: DireccionMisii[];
    atributos?: AtributoMisii[];
    alertas?: unknown[];
  }>(html, 'DatosCntrNow');

  // El contribuyente es el único bloque sin el cual la ficha no significa nada:
  // sin él no hay ni RUT contra el que verificar identidad. Los demás pueden
  // venir vacíos de forma legítima (una empresa sin atributos es posible).
  if (!now.contribuyente || !now.contribuyente.rut) {
    throw new EstructuraMisiiDesconocida(
      'DatosCntrNow no trae el bloque `contribuyente` con RUT: cambió la estructura de la página.'
    );
  }

  return {
    contribuyente: now.contribuyente,
    direcciones: now.direcciones ?? [],
    atributos: now.atributos ?? [],
    alertas: now.alertas ?? [],
    actividades: parsear<ActividadMisii[]>(html, 'DatosActeco'),
  };
}

export class MisiiScraper {
  constructor(private http: SiiHttpClient) {}

  async ficha(): Promise<FichaCruda> {
    return parsearFicha(await this.http.get(URL_HOME));
  }
}
