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

// Título de la página del informe, que el CGI emite tenga o no datos el
// contribuyente. Sirve como evidencia de que la respuesta ES este informe y no
// una página de error: ver el uso en `parsearSituacionTributaria`.
//
// La marca es ASCII PURO a propósito: "Tributaria de Terceros", sin la `ó` de
// "Situación". Verificado en los bytes crudos del CGI que el título viene con la
// entidad `&oacute;` y no con el byte 0xF3 de latin1, así que hoy cualquiera de
// las dos formas funcionaría — pero si mañana el SII manda el byte crudo y la
// decodificación falla, ese carácter se vuelve U+FFFD y la marca dejaría de
// matchear. Entonces una respuesta BUENA se reportaría como "el SII no devolvió
// la página", que es el error opuesto al que este chequeo existe para evitar.
// Anclando a ASCII, el chequeo no depende de que la decodificación salga bien.
const MARCA_INFORME = /Tributaria\s+de\s+Terceros/i;

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
  /** RUT canónico con guion, como lo reporta el SII (ej. "22222222-2"). */
  rut: string;
  razonSocial: string | null;
  inicioActividades: boolean | null;
  fechaInicioActividades: string | null;
  /** "Empresa de menor tamaño" (Ley 20.416): el pro-pyme del portal. */
  proPyme: boolean | null;
  monedaExtranjera: boolean | null;
  actividades: ActividadEconomica[];
};

// Transporte inyectable: la implementación real pega por HTTP, pero los tests pasan
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

  // ANTES de concluir "sin datos", exigir evidencia POSITIVA de que esto es la
  // página del informe. Sin este chequeo, una página de mantención, un error del
  // portal o un rediseño del CGI también llegaban sin razón social ni RUT, y se
  // reportaban como NO_ENCONTRADO —permanente, "este RUT no tiene datos"— o sea
  // que el SII caído era indistinguible de un contribuyente inexistente. El
  // consumidor archivaba un "no existe" sobre un fallo transitorio y nadie
  // volvía a mirarlo.
  //
  // La marca es el título de la página y no un campo de datos, así que está
  // igual cuando el contribuyente no tiene nada que informar. Se lanza Error
  // pelado a propósito: es el ERROR genérico del contrato REST, el único que el
  // consumidor debe reintentar.
  if (!MARCA_INFORME.test(html)) {
    throw new Error(
      'El SII no devolvió la página de situación tributaria. Pudo ser un error del portal; reintentá.'
    );
  }

  // Con la página correcta a la vista, la ausencia de los dos campos sí
  // significa que el SII no reconoció al contribuyente.
  if (razonSocial == null && rutReportado == null) {
    throw new RecursoNoEncontrado(`El SII no tiene datos para el RUT ${rutPedido}.`);
  }

  // Verificar que la página corresponde al RUT pedido: el portal puede
  // responder con otro contribuyente y no hay que atribuir datos ajenos.
  //
  // Se comparan CUERPO Y DÍGITO VERIFICADOR. Antes se comparaba sólo el cuerpo,
  // y eso dejaba pasar una consulta con el DV equivocado: el SII resuelve por
  // el cuerpo, devolvía los datos con su DV correcto, la comparación de cuerpos
  // daba igual y la API respondía OK a un RUT que no existe. La ruta ya rechaza
  // el DV inválido antes de llegar acá, así que esto es la segunda barrera: si
  // alguien llama al scraper directo, o si mañana se relaja la validación de la
  // ruta, el chequeo sigue en pie.
  if (rutReportado) {
    const pedido = partirRut(rutPedido);
    // Un reportado ilegible se trata como "otro contribuyente" (no atribuir).
    let reportado: { rut: string; dv: string } | null = null;
    try {
      reportado = partirRut(rutReportado);
    } catch {
      reportado = null;
    }
    if (reportado?.rut !== pedido.rut || reportado?.dv !== pedido.dv) {
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

// --- Transporte real --------------------------------------------------------

// Los campos del form se codifican con encodeURIComponent; no hace falta el
// encode latin1 que sí necesitan los CGI que reciben texto con acentos.
export function transporteCurl(): TransporteSituacion {
  return {
    async obtenerCaptcha(): Promise<string> {
      const { contenido } = await postear(URL_CAPTCHA, 'oper=0');
      try {
        const json = JSON.parse(contenido.toString('utf-8'));
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
      const { contenido, contentType } = await postear(URL_GETSTC, cuerpo);
      return decodificarRespuesta(contenido, contentType);
    },
  };
}

// Un POST plano al CGI, con `fetch` y NO con curl sincrónico. Es la diferencia
// que hace usable este endpoint: `execFileSync` bloquea el event loop de Node
// mientras corre, así que dos consultas seriales de 25s cada una congelaban el
// proceso ENTERO —todos los tenants, todas las rutas— hasta ~50s por request.
// En los demás dominios el mismo patrón es tolerable porque sus consultas se
// serializan por sesión del SII y exigen credencial; acá no hay nada que las
// serialice, así que un solo tenant dejaba el servidor mudo.
//
// Tampoco hay motivo para curl en esta consulta: no hay cookie jar que pasar y
// los campos del form son ASCII (dígitos del RUT, código, base64 del captcha),
// así que no se necesita el encode latin1 que sí requieren otros CGI.
//
// Se verifica TLS (curl acá iba con `-k`). Comprobado en vivo que zeus.sii.cl
// presenta cadena válida: desactivar la verificación en un dato que se usa para
// decidir con quién se factura permitiría que un MITM inyecte una razón social.
// El handshake TLS de `getstc` falla de forma intermitente: medido 3 de 12
// intentos con ERR_SSL_LAST_OCTET_INVALID, mientras el endpoint del captcha no
// falló ninguna vez. Parece un servidor detrás del balanceador con la cadena
// mal armada, y explica por qué la versión con curl usaba `-k`: enmascaraba
// esto a costa de aceptar cualquier certificado.
//
// No se desactiva la verificación: este dato se usa para decidir con quién se
// factura, y un MITM podría inyectar una razón social. Se reintenta, que
// mantiene la verificación y cubre el fallo — con ~25% de fallo por intento,
// tres intentos dejan un residuo de ~1,5%.
//
// Sólo se reintentan los fallos de CONEXIÓN (el handshake nunca llegó a mandar
// el POST, así que el captcha sigue sin consumirse). Un status HTTP de error no
// se reintenta acá: lo decide quien llama, y reintentar un 500 del portal sólo
// multiplica la carga sobre un servicio que ya está en problemas.
const INTENTOS_CONEXION = 3;

async function fetchConReintento(url: string, cuerpo: string): Promise<Response> {
  let ultimo: unknown;
  for (let intento = 1; intento <= INTENTOS_CONEXION; intento++) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: cuerpo,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      ultimo = e;
      // Un timeout no se reintenta: si el portal tardó más de TIMEOUT_MS, pedirle
      // lo mismo dos veces más sólo suma esa espera de nuevo.
      if ((e as Error)?.name === 'TimeoutError') break;
    }
  }

  // No se propaga el mensaje original: puede traer la URL con el cuerpo del
  // POST y termina en el log central. Mismo criterio que http.ts.
  const causa = (ultimo as Error)?.name === 'TimeoutError'
    ? 'expiró el tiempo de espera'
    : `falló la conexión tras ${INTENTOS_CONEXION} intento(s)`;
  throw new Error(`No se pudo consultar el SII: ${causa}.`);
}

async function postear(url: string, cuerpo: string): Promise<{ contenido: Buffer; contentType: string }> {
  const resp = await fetchConReintento(url, cuerpo);

  // El status se chequea ANTES de leer el cuerpo. `curl` devolvía el body de un
  // 500 sin distinguirlo de una respuesta buena, y aunque el chequeo de
  // MARCA_INFORME lo atrapa igual, el operador perdía el dato más útil para
  // diagnosticar: que el portal contestó un error, y cuál.
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`El SII respondió ${resp.status} a la consulta de situación tributaria.`);
  }

  // El cuerpo se lee por chunks con un techo, no con `arrayBuffer()`: una
  // respuesta inesperadamente grande (el portal devolviendo algo que no es esta
  // página) se traería entera a memoria antes de que nadie pudiera rechazarla.
  const trozos: Buffer[] = [];
  let total = 0;
  if (resp.body) {
    for await (const trozo of resp.body as unknown as AsyncIterable<Uint8Array>) {
      total += trozo.byteLength;
      if (total > MAX_RESPUESTA_BYTES) {
        // Se cancela el body antes de lanzar: sin esto la conexión queda sin
        // drenar y el socket colgado hasta que el runtime lo recoja.
        await resp.body?.cancel();
        throw new LimitacionConocida(
          `La respuesta del SII superó ${MAX_RESPUESTA_BYTES} bytes, así que se cortó sin parsearla.`,
          { codigo: 'RESPUESTA_GRANDE' }
        );
      }
      trozos.push(Buffer.from(trozo));
    }
  }

  return {
    contenido: Buffer.concat(trozos),
    contentType: resp.headers.get('content-type') ?? '',
  };
}
