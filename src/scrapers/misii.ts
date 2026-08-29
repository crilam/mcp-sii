import { SiiHttpClient } from '../http';
import { LimitacionConocida } from '../erroresConsulta';
import { SesionExpirada } from '../erroresSesion';

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
//
// Hereda de `LimitacionConocida` y no de `Error` porque es PERMANENTE: hasta
// que alguien arregle el parser, la consulta va a fallar igual. El adaptador
// REST colapsa cualquier error desconocido a `ERROR`, que en el contrato
// significa "reintentá", y ahí el tenant reintenta en loop algo que no puede
// funcionar — gastando una sesión del SII en cada vuelta. Como `LIMITE_CONOCIDO`
// llega con el mensaje correcto: no reintentes, esto hay que arreglarlo.
export class EstructuraMisiiDesconocida extends LimitacionConocida {}

// Marcadores del formulario de login del SII. Si la sesión no llegó a
// `misiir.sii.cl` —cookie vencida, o un login que no propagó—, el portal
// devuelve esa página en vez de la ficha. Ahí tampoco está `DatosCntrNow`, así
// que sin distinguirlo el diagnóstico sale al revés por partida doble: dice
// "cambió la estructura de la página", que es falso, y lo marca permanente
// cuando la sesión vencida se arregla sola reintentando.
//
// Marcadores del FORMULARIO de login, no de la palabra "clave": la ficha
// legítima habla de la clave tributaria en su propio menú ("Historial de
// Cambios de Clave Tributaria"), y una primera versión que contaba menciones de
// texto declaró expirada una sesión perfectamente válida — verificado en vivo
// contra el portal. Sólo el formulario distingue las dos páginas.
const MARCAS_LOGIN = [/name=['"]?rutcntr/i, /CAutInicio\.cgi/i];

function esPaginaDeLogin(html: string): boolean {
  return MARCAS_LOGIN.some(m => m.test(html));
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
  // El nombre se escapa aunque hoy todos los llamadores usen literales fijos:
  // el día que alguien pase un nombre con un punto o un paréntesis, el regex
  // matchearía de más y devolvería el payload equivocado — un error silencioso,
  // que es la clase que este archivo trata de no tener.
  const nombreEscapado = nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const asignacion = new RegExp(`\\b${nombreEscapado}\\s*=\\s*([{[])`);
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
    // La clasificación corre SÓLO acá, cuando ya se sabe que el payload no
    // está: preguntarse antes "¿esto es el login?" sobre una página que sí
    // trae los datos es buscar un problema donde no lo hay, y fue exactamente
    // el falso positivo de la primera versión.
    if (esPaginaDeLogin(html)) {
      throw new SesionExpirada(
        'El portal devolvió la página de login en vez de la ficha: la sesión del SII no está vigente.'
      );
    }
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
    codigoError?: number;
    descripcionError?: string | null;
    contribuyente?: ContribuyenteMisii;
    direcciones?: DireccionMisii[];
    atributos?: AtributoMisii[];
    alertas?: unknown[];
  }>(html, 'DatosCntrNow');

  // El propio payload informa errores del SII. Se mira ANTES de concluir nada
  // sobre la estructura: un `codigoError` distinto de cero significa que la
  // página está bien y el problema es otro, y su descripción es justamente lo
  // que necesita quien diagnostica.
  if (typeof now.codigoError === 'number' && now.codigoError !== 0) {
    throw new LimitacionConocida(
      `El SII rechazó la consulta de la ficha (código ${now.codigoError}): ` +
      `${now.descripcionError ?? 'sin descripción'}.`
    );
  }

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
    // Las alertas salen de `DatosCntrNow.alertas` y NO de `DatosCntrAler`, que
    // también trae un array `alertas`. Es una elección, no un descuido: en el
    // relevamiento las dos vinieron vacías, así que no hay evidencia de en qué
    // se diferencian, y leer las dos obligaría a inventar una regla de mezcla
    // sin saber si son la misma lista. Se toma la del payload que ya se parsea
    // por otras razones; el día que alguna traiga datos, hay con qué decidir.
    actividades: parsear<ActividadMisii[]>(html, 'DatosActeco'),
  };
}

export class MisiiScraper {
  constructor(private http: SiiHttpClient) {}

  async ficha(): Promise<FichaCruda> {
    return parsearFicha(await this.http.get(URL_HOME));
  }
}
