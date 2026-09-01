import { partirRut } from '../rut';
import { RecursoNoEncontrado, LimitacionConocida } from '../erroresConsulta';

// Consulta pública de "situación tributaria de terceros" del SII. A diferencia
// del resto de los dominios de este repo, NO requiere clave ni certificado ni
// una sesión iniciada: cualquiera puede consultar cualquier RUT.
//
// El SII dio de baja el CGI legacy (`zeus.sii.cl/cvc_cgi/stc/*`) que usaba la
// primera versión de este scraper — verificado en vivo el 01-09-2026: devuelve
// 404/500. La SPA actual (`www2.sii.cl/stc/`, Vue) pega a una API JSON nueva.
// Se reescribió contra ESA API, releída del bundle minificado de la SPA (no hay
// documentación pública): `getConsultaData` es el POST real, con los mismos
// campos `rut`/`dv` que manda el form.
const URL_RECAPTCHA_KEY = 'https://www2.sii.cl/app/stc/recurso/v1/recaptcha/key';
const URL_CONSULTA = 'https://www2.sii.cl/app/stc/recurso/v1/consulta/getConsultaData/';

const TIMEOUT_MS = 25_000;

export type ActividadEconomica = {
  codigo: number | null;
  giro: string | null;
  /** "Primera"/"Segunda" del SII, mapeada a 1/2; null si no se reconoce. */
  categoria: number | null;
  afectaIva: boolean | null;
};

export type SituacionTributaria = {
  /** RUT canónico con guion, tal como se pidió (la API nueva no lo reporta de vuelta). */
  rut: string;
  razonSocial: string | null;
  inicioActividades: boolean | null;
  fechaInicioActividades: string | null;
  /** "Empresa de Menor Tamaño" (Ley 20.416): el pro-pyme del portal (`tieneEMTP`). */
  proPyme: boolean | null;
  /**
   * La API nueva no expone este dato (sí lo hacía el CGI viejo, como texto
   * libre). Se deja el campo por compatibilidad del contrato REST, siempre
   * `null` hasta que aparezca un equivalente.
   */
  monedaExtranjera: boolean | null;
  actividades: ActividadEconomica[];
};

// Transporte inyectable: la implementación real pega por HTTP, pero los tests
// pasan una que devuelve fixtures, así no tocan la red.
export interface TransporteSituacion {
  /** GET a recaptcha/key → si el SII lo tiene habilitado, no hay como resolverlo sin un flujo interactivo. */
  recaptchaHabilitado(): Promise<boolean>;
  /** POST a getConsultaData con rut/dv → el JSON crudo del SII. */
  consultarDatos(rut: string, dv: string): Promise<unknown>;
}

// --- Parseo -----------------------------------------------------------------

type RespuestaCruda = {
  registrado?: unknown;
  nombre?: unknown;
  inicioActividades?: unknown;
  fechaInicioActividades?: unknown;
  tieneEMTP?: unknown;
  girosNegocio?: unknown;
};

type GiroCrudo = {
  codigo?: unknown;
  descripcion?: unknown;
  categoriaTributaria?: unknown;
  indicadorAfectoIva?: unknown;
};

function comoBooleanoONull(valor: unknown): boolean | null {
  return typeof valor === 'boolean' ? valor : null;
}

function comoTextoONull(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const s = valor.trim();
  return s === '' ? null : s;
}

function parsearActividades(crudo: unknown): ActividadEconomica[] {
  if (!Array.isArray(crudo)) return []
  return crudo
    .filter((g): g is GiroCrudo => typeof g === 'object' && g !== null)
    .map((g) => {
      const codigoTxt = typeof g.codigo === 'string' || typeof g.codigo === 'number' ? String(g.codigo) : null
      const categoriaTxt = typeof g.categoriaTributaria === 'string' ? g.categoriaTributaria : null
      return {
        giro: comoTextoONull(g.descripcion),
        codigo: codigoTxt && /^\d+$/.test(codigoTxt) ? Number(codigoTxt) : null,
        categoria: categoriaTxt === '1' || categoriaTxt === '2' ? Number(categoriaTxt) : null,
        afectaIva: g.indicadorAfectoIva == null ? null : String(g.indicadorAfectoIva).toUpperCase() === 'S',
      }
    })
}

/**
 * Parsea la respuesta de `getConsultaData` a la forma normalizada. Lanza
 * `RecursoNoEncontrado` si `registrado` es `false` — la propia API lo dice
 * explícito, a diferencia del CGI viejo que había que inferirlo de campos
 * ausentes.
 */
export function parsearSituacionTributaria(cruda: unknown, rutPedido: string): SituacionTributaria {
  if (typeof cruda !== 'object' || cruda === null) {
    throw new Error('El SII no devolvió un JSON reconocible para la consulta de situación tributaria.');
  }
  const r = cruda as RespuestaCruda;

  if (r.registrado === false) {
    throw new RecursoNoEncontrado(`El SII no tiene datos para el RUT ${rutPedido}.`);
  }

  return {
    rut: rutPedido,
    razonSocial: comoTextoONull(r.nombre),
    inicioActividades: comoBooleanoONull(r.inicioActividades),
    fechaInicioActividades: comoTextoONull(r.fechaInicioActividades),
    proPyme: comoBooleanoONull(r.tieneEMTP),
    monedaExtranjera: null,
    actividades: parsearActividades(r.girosNegocio),
  };
}

// --- Orquestación ------------------------------------------------------------

/**
 * Consulta la situación tributaria de un RUT contra el SII, sin sesión.
 * `transporte` se inyecta para poder testear sin red.
 */
export async function consultarSituacionTributaria(
  rutCompleto: string,
  transporte: TransporteSituacion = transporteFetch()
): Promise<SituacionTributaria> {
  const { rut, dv } = partirRut(rutCompleto);

  // La API expone si el reCAPTCHA está activo (`enable`). Está apagado desde
  // que se relevó este endpoint (01-09-2026), pero el SII puede prenderlo en
  // cualquier momento — y un reCAPTCHA Enterprise no se resuelve sin un flujo
  // interactivo real, así que se falla explícito en vez de mandar un token
  // vacío y que el SII lo rechace con un mensaje genérico.
  if (await transporte.recaptchaHabilitado()) {
    throw new LimitacionConocida(
      'El SII activó reCAPTCHA para esta consulta; no se puede resolver sin un flujo interactivo.',
      { codigo: 'RECAPTCHA_ACTIVO' },
    );
  }

  const cruda = await transporte.consultarDatos(rut, dv);
  return parsearSituacionTributaria(cruda, `${rut}-${dv}`);
}

// --- Transporte real --------------------------------------------------------

async function fetchConTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const causa = (e as Error)?.name === 'TimeoutError' ? 'expiró el tiempo de espera' : 'falló la conexión';
    throw new Error(`No se pudo consultar el SII: ${causa}.`);
  }
}

export function transporteFetch(): TransporteSituacion {
  return {
    async recaptchaHabilitado(): Promise<boolean> {
      const resp = await fetchConTimeout(URL_RECAPTCHA_KEY, { method: 'GET' });
      if (!resp.ok) {
        // Un fallo acá es indicio de que el SII cambió esta ruta también: se
        // trata como reCAPTCHA activo (falla cerrado) en vez de asumir que
        // sigue apagado y arriesgar mandar un token vacío al SII.
        return true;
      }
      let cuerpo: { enable?: unknown };
      try {
        cuerpo = (await resp.json()) as { enable?: unknown };
      } catch {
        return true;
      }
      return cuerpo.enable !== false;
    },
    async consultarDatos(rut: string, dv: string): Promise<unknown> {
      const resp = await fetchConTimeout(URL_CONSULTA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rut, dv, reAction: '', reToken: '' }),
      });
      if (!resp.ok) {
        throw new Error(`El SII respondió ${resp.status} a la consulta de situación tributaria.`);
      }
      try {
        return await resp.json();
      } catch {
        throw new Error('El SII no devolvió un JSON válido para la consulta de situación tributaria.');
      }
    },
  };
}
