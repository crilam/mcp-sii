import { execFileSync } from 'child_process';
import { partirRut } from '../rut';
import { decodificarRespuesta } from '../http';
import { RecursoNoEncontrado, LimitacionConocida } from '../erroresConsulta';

// Consulta pública de "situación tributaria de terceros" del SII. A diferencia
// del resto de los dominios de este repo, NO requiere clave ni certificado ni
// una sesión iniciada: cualquiera puede consultar cualquier RUT. Por eso no usa
// SessionManager ni SiiHttpClient (que exige cookie jar), sino un transporte
// propio, mínimo, que hace dos POST planos contra zeus.sii.cl.
//
// El "captcha" del portal para esta consulta no es un desafío real: el endpoint
// de captcha devuelve un blob base64 que ya CONTIENE el código de 4 caracteres
// que hay que reenviar (bytes 36..40 del blob decodificado). No hay imagen ni
// OCR; es el mecanismo documentado del propio CGI y así lo consume el cliente
// oficial del portal.

// URLs del CGI legacy (la página https://www2.sii.cl/stc/noauthz es sólo una
// SPA que termina pegándole a esto).
const URL_CAPTCHA = 'https://zeus.sii.cl/cvc_cgi/stc/CViewCaptcha.cgi';
const URL_GETSTC = 'https://zeus.sii.cl/cvc_cgi/stc/getstc';

const TIMEOUT_MS = 25_000;
const MAX_RESPUESTA_BYTES = 2 * 1024 * 1024;

export type ActividadEconomica = {
  codigo: number | null;
  giro: string | null;
  /** "Primera"/"Segunda" del SII, mapeada a 1/2; null si no se reconoce. */
  categoria: number | null;
  afectaIva: boolean | null;
};

export type SituacionTributaria = {
  /** RUT canónico con guion, como lo reporta el SII (ej. "76632059-7"). */
  rut: string;
  razonSocial: string | null;
  inicioActividades: boolean | null;
  fechaInicioActividades: string | null;
  /** "Empresa de menor tamaño" (Ley 20.416): el pro-pyme del portal. */
  proPyme: boolean | null;
  monedaExtranjera: boolean | null;
  actividades: ActividadEconomica[];
};

// Transporte inyectable: la implementación real usa curl, pero los tests pasan
// una que devuelve fixtures, así no tocan la red ni el captcha.
export interface TransporteSituacion {
  /** POST a CViewCaptcha.cgi → string base64 `txtCaptcha`. */
  obtenerCaptcha(): Promise<string>;
  /** POST a getstc con los campos del form → HTML decodificado (latin1). */
  consultarGetstc(campos: Record<string, string>): Promise<string>;
}

// --- Parseo -----------------------------------------------------------------

const ENTIDADES: Record<string, string> = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', deg: '°',
  agrave: 'à', amp: '&', nbsp: ' ', quot: '"', lt: '<', gt: '>',
};

function decodificarEntidades(texto: string): string {
  return texto
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([A-Za-z]+);/g, (m, nombre) => ENTIDADES[nombre] ?? m);
}

function limpiar(texto: string | undefined | null): string | null {
  if (texto == null) return null;
  const s = decodificarEntidades(texto).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

function comoBooleano(valor: string | null): boolean | null {
  if (valor == null) return null;
  const s = valor.trim().toUpperCase();
  if (s === 'SI' || s === 'SÍ') return true;
  if (s === 'NO') return false;
  return null;
}

function categoriaANumero(texto: string | null): number | null {
  if (texto == null) return null;
  const s = texto.trim().toLowerCase();
  if (s === 'primera') return 1;
  if (s === 'segunda') return 2;
  return null;
}

// Devuelve el primer grupo capturado, ya limpiado, o null.
function extraer(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? limpiar(m[1]) : null;
}

function parsearActividades(html: string): ActividadEconomica[] {
  // La página tiene VARIAS tablas class="tabla" (documentos electrónicos,
  // autorización no electrónica con rangos de fecha, documentos timbrados). La
  // de actividades es la PRIMERA y va inmediatamente después del rótulo
  // "Actividades Económicas vigentes:". Anclar ahí evita que las filas de las
  // otras tablas (sobre todo las fechas de la de "no electrónico") entren como
  // actividades basura.
  const bloque = /Actividades Econ(?:&oacute;|ó)micas vigentes:[\s\S]*?<table[^>]*class="tabla"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!bloque) return [];

  const filas = bloque[1].match(/<TR>[\s\S]*?<\/TR>/gi) ?? [];
  const actividades: ActividadEconomica[] = [];
  for (const fila of filas) {
    // La fila de encabezado trae <strong> en sus celdas; las de datos no.
    if (/<strong>/i.test(fila)) continue;
    const celdas = [...fila.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/gi)].map(m => limpiar(m[1]));
    if (celdas.length < 4) continue;
    const codigoTxt = celdas[1];
    const codigo = codigoTxt && /^\d+$/.test(codigoTxt) ? Number(codigoTxt) : null;
    actividades.push({
      giro: celdas[0],
      codigo,
      categoria: categoriaANumero(celdas[2]),
      afectaIva: celdas[3] == null ? null : celdas[3].toUpperCase() === 'SI',
    });
  }
  return actividades;
}

/**
 * Parsea el HTML de getstc a la forma normalizada. Lanza `RecursoNoEncontrado`
 * si el RUT consultado no tiene datos, o si el RUT que reporta la página no
 * coincide con el pedido: atribuirle a un contribuyente la razón social de otro
 * es peor que no tener el dato.
 */
export function parsearSituacionTributaria(html: string, rutPedido: string): SituacionTributaria {
  const razonSocial = extraer(html, /Nombre o Raz(?:&oacute;|ó)n Social[^:]*:\s*<\/strong>\s*<\/div>\s*<div[^>]*>([^<]*)</i);
  const rutReportado = extraer(html, /RUT Contribuyente[^:]*:\s*<\/b>\s*<br>\s*<\/div>\s*<div[^>]*>([^<]*)</i);

  // Sin razón social ni RUT reportado, el SII no reconoció al contribuyente.
  if (razonSocial == null && rutReportado == null) {
    throw new RecursoNoEncontrado(`El SII no tiene datos para el RUT ${rutPedido}.`);
  }

  // Verificar que la página corresponde al RUT pedido (comparando sólo el
  // cuerpo, sin puntos ni guion): el portal a veces puede responder con otro
  // contribuyente y no queremos atribuir datos ajenos.
  if (rutReportado) {
    const cuerpoPedido = partirRut(rutPedido).rut;
    // `partirRut` separa el dígito verificador; comparar sólo el cuerpo. Un
    // reportado ilegible se trata como "otro contribuyente" (no atribuir).
    let cuerpoReportado: string | null = null;
    try {
      cuerpoReportado = partirRut(rutReportado).rut;
    } catch {
      cuerpoReportado = null;
    }
    if (cuerpoReportado !== cuerpoPedido) {
      throw new RecursoNoEncontrado(
        `El SII devolvió el RUT ${rutReportado} para una consulta de ${rutPedido}.`
      );
    }
  }

  return {
    rut: rutReportado ?? rutPedido,
    razonSocial,
    inicioActividades: comoBooleano(extraer(html, /Contribuyente presenta Inicio de Actividades:\s*([^<]*)</i)),
    fechaInicioActividades: extraer(html, /Fecha de Inicio de Actividades:\s*([^<]*)</i),
    proPyme: comoBooleano(extraer(html, /Empresa de Menor Tama(?:&ntilde;|ñ)o[\s\S]*?<\/span>:\s*([A-Za-zÍíÓó]+)/i)),
    monedaExtranjera: comoBooleano(extraer(html, /declarar y pagar sus impuestos en moneda extranjera:\s*([^<]*)</i)),
    actividades: parsearActividades(html),
  };
}

// --- Captcha y orquestación -------------------------------------------------

/**
 * Extrae el código del blob del captcha. El endpoint de captcha del SII
 * devuelve un base64 cuyos bytes 36..40 (una vez decodificado) SON el código
 * de 4 caracteres que hay que reenviar. Mecanismo del propio CGI, no un
 * bypass de una imagen.
 */
export function codigoCaptcha(txtCaptcha: string): string {
  const bytes = Buffer.from(txtCaptcha, 'base64');
  const codigo = bytes.subarray(36, 40).toString('latin1');
  if (!/^[A-Za-z0-9]{4}$/.test(codigo)) {
    throw new LimitacionConocida('El captcha del SII no tuvo el formato esperado.', { codigo: 'CAPTCHA' });
  }
  return codigo;
}

/**
 * Consulta la situación tributaria de un RUT contra el SII, sin sesión.
 * `transporte` se inyecta para poder testear sin red ni captcha real.
 */
export async function consultarSituacionTributaria(
  rutCompleto: string,
  transporte: TransporteSituacion = transporteCurl()
): Promise<SituacionTributaria> {
  const { rut, dv } = partirRut(rutCompleto);
  const txtCaptcha = await transporte.obtenerCaptcha();
  const code = codigoCaptcha(txtCaptcha);
  const html = await transporte.consultarGetstc({
    RUT: rut,
    DV: dv,
    PRG: 'STC',
    OPC: 'NOR',
    txt_code: code,
    txt_captcha: txtCaptcha,
  });
  return parsearSituacionTributaria(html, `${rut}-${dv}`);
}

// --- Transporte real (curl) -------------------------------------------------

// Se hace curl con argv array (nunca por shell) igual que src/http.ts, para que
// ningún valor pase por un intérprete de comandos. Los campos del form son
// ASCII (dígitos del RUT, código, base64 del captcha), así que se codifican con
// encodeURIComponent; no hace falta el encode latin1 que sí necesitan los CGI
// que reciben texto con acentos.
export function transporteCurl(): TransporteSituacion {
  return {
    async obtenerCaptcha(): Promise<string> {
      const salida = curl(['--data', 'oper=0', URL_CAPTCHA]);
      try {
        const json = JSON.parse(salida.toString('utf-8'));
        if (typeof json.txtCaptcha !== 'string' || json.txtCaptcha === '') {
          throw new Error('sin txtCaptcha');
        }
        return json.txtCaptcha;
      } catch {
        throw new LimitacionConocida('El SII no devolvió un captcha válido.', { codigo: 'CAPTCHA' });
      }
    },
    async consultarGetstc(campos: Record<string, string>): Promise<string> {
      const cuerpo = Object.entries(campos)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const { contenido, contentType } = curlCrudo(['--data-binary', cuerpo, URL_GETSTC]);
      return decodificarRespuesta(contenido, contentType);
    },
  };
}

const MARCA = '\n__MCP_SII_CT__:';

function curl(args: string[]): Buffer {
  return curlCrudo(args).contenido;
}

function curlCrudo(args: string[]): { contenido: Buffer; contentType: string } {
  let salida: Buffer;
  try {
    salida = execFileSync('curl', [
      '-sk', '-L', '--max-redirs', '5', '--max-time', '25',
      '-w', `${MARCA}%{content_type}`,
      ...args,
    ], { encoding: 'buffer', timeout: TIMEOUT_MS, maxBuffer: MAX_RESPUESTA_BYTES });
  } catch (e) {
    // No se propaga el mensaje de execFileSync: trae el comando completo (con el
    // cuerpo del POST) y termina en el log central. Mismo criterio que http.ts.
    const status = (e as { status?: number })?.status;
    throw new Error(`Falló la consulta HTTP al SII${status !== undefined ? ` (curl salió ${status})` : ''}.`);
  }
  const corte = salida.lastIndexOf(MARCA);
  if (corte === -1) return { contenido: salida, contentType: '' };
  return {
    contenido: salida.subarray(0, corte),
    contentType: salida.subarray(corte + MARCA.length).toString('ascii').trim(),
  };
}
