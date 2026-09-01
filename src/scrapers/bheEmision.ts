import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EscrituraRechazadaPorSii, LimitacionConocida } from '../erroresConsulta';
import { marcarSeguro } from '../idempotenciaEscritura';
import { partirRut } from '../rut';

// EMISIÓN de Boletas de Honorarios Electrónicas (ronda 11). Es la cadena CGI
// del portal (`loa.sii.cl/cgi_IMT/TMBECN_*`), la misma familia que la LECTURA de
// BHE que este repo ya consulta hace semanas:
//
//   1. TMBECN_ValidaTimbrajeContrib.cgi?modo=1   pantalla de tipo de retención
//   2. TMBECN_PresentaDatosBoleta.cgi            formulario (POST retención)
//   3. TMBECN_ConfirmaTimbrajeContrib.cgi        PREVISUALIZA — valida, NO emite
//   4. TMBECN_BoletaHonorariosElectronica.cgi    EMITE — asigna folio
//
// No hay sesión de wizard en el servidor: el estado viaja en campos ocultos que
// cada paso reenvía. Por eso el paso 2 se parsea DINÁMICAMENTE y sus campos se
// PROPAGAN tal cual (incluido `tiempo`, un timestamp que el server inyecta),
// sobreescribiendo sólo lo que el emisor aporta: no se adivina ningún name.
//
// El guardrail de la ronda 11: `confirmar:false` (default) recorre 1→3 y
// devuelve la previsualización del SII (montos reales: bruto, retención,
// líquido) SIN emitir; `confirmar:true` sigue al paso 4 — acto tributario REAL e
// IRREVERSIBLE que notifica al receptor.
const BASE = 'https://loa.sii.cl/cgi_IMT';
const PASO1_URL = `${BASE}/TMBECN_ValidaTimbrajeContrib.cgi`;
const PASO2_URL = `${BASE}/TMBECN_PresentaDatosBoleta.cgi`;
const PASO3_URL = `${BASE}/TMBECN_ConfirmaTimbrajeContrib.cgi`;
const PASO4_URL = `${BASE}/TMBECN_BoletaHonorariosElectronica.cgi`;

export interface LineaBhe {
  // El portal acepta hasta 4 líneas de prestación.
  descripcion: string;
  valor: number;
}

export interface EmitirBheParams {
  receptor: {
    rut: string; // con DV: 66666666-6
    nombre: string;
    direccion?: string;
    comuna?: string;
  };
  lineas: LineaBhe[];
  // true = la retención la efectúa el RECEPTOR (la empresa, RETRECEPTOR);
  // false = la retiene el emisor (RETCONTRIBUYENTE). Default true, el caso
  // típico de boletas a empresas.
  retieneReceptor?: boolean;
  // AAAA-MM-DD. Si se omite, la fecha que trae el formulario del portal.
  fecha?: string;
}

export interface PrevisualizacionBhe {
  emitida: false;
  // Montos que calculó EL SII en la previsualización (no nosotros).
  bruto: number | null;
  retencion: number | null;
  liquido: number | null;
  receptorRut: string;
  receptorNombre: string;
  lineas: LineaBhe[];
  // Texto plano de la previsualización, para que el consumidor la revise entera.
  detalle: string;
}

export interface BheEmitida {
  emitida: true;
  // Folio (número de boleta) que reporta el SII al emitir. `null` si la página
  // de emisión no lo dejó leer — en ese caso hay que confirmarlo con la lectura
  // de emitidas, y el mensaje lo dice.
  folio: number | null;
  bruto: number | null;
  retencion: number | null;
  liquido: number | null;
  detalle: string;
}

const MAX_LINEAS = 4;

// --- parsing ---------------------------------------------------------------

/** Todos los inputs/selects con name del HTML, con su value (crudos del server). */
export function parsearCamposForm(html: string): Record<string, string> {
  const campos: Record<string, string> = {};
  for (const m of html.matchAll(/<(?:input|select|textarea)\b[^>]*>/gi)) {
    const tag = m[0];
    const name = /name=["']?([A-Za-z0-9_]+)/i.exec(tag)?.[1];
    if (!name) continue;
    const tipo = /type=["']?([a-z]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (tipo === 'button' || tipo === 'submit' || tipo === 'reset') continue;
    const value = /value=["']([^"']*)/i.exec(tag)?.[1] ?? '';
    // Un radio sólo aporta su value si está checked; los demás pisan con "".
    if (tipo === 'radio' && !/\bchecked\b/i.test(tag)) continue;
    campos[name] = value;
  }
  return campos;
}

/** Reduce una página a texto plano legible (para detalle y mensajes). */
function textoPlano(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Un monto del SII que viene PEGADO a su etiqueta: "Total Honorarios: $ 2.043.689".
// Exige el `$` inmediatamente después de la etiqueta (los montos del portal lo
// traen), para NO tomar un número de otro campo por proximidad si el layout
// cambia. Ante la duda devuelve null —que se lee como "no se pudo leer"— en vez
// de una cifra equivocada sobre la que el usuario confirmaría una emisión.
function montoTras(texto: string, etiquetas: RegExp): number | null {
  const m = etiquetas.exec(texto);
  if (!m) return null;
  const despues = texto.slice(m.index + m[0].length, m.index + m[0].length + 18);
  const n = /^\s*:?\s*\$\s*([\d]{1,3}(?:\.[\d]{3})*|\d+)/.exec(despues);
  if (!n) return null;
  return parseInt(n[1].replace(/\./g, ''), 10);
}

// La página de login del SII, para distinguir "sesión caída" de un rechazo.
const ES_LOGIN = /IngresoRutClave|Ingresar Clave Tributaria|CAutInicio/i;

// --- scraper ----------------------------------------------------------------

export class BheEmisionScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  /**
   * Emite (o previsualiza) una BHE. `confirmar:false` recorre hasta la
   * previsualización del paso 3 y NO emite. `confirmar:true` ejecuta el paso 4.
   */
  async emitir(params: EmitirBheParams, confirmar = false): Promise<PrevisualizacionBhe | BheEmitida> {
    this.session.assertPuedeEntregarCookieJar();

    // FASE PRE-ENVÍO (pasos 1-3): nada de esto emite. Cualquier error acá es
    // seguro de liberar para la red anti-doble-click.
    let camposPaso3: Record<string, string>;
    let preview: PrevisualizacionBhe;
    try {
      this.validarParams(params);
      const campos2 = await this.cargarFormulario(params.retieneReceptor !== false);
      const camposLlenos = this.llenarFormulario(campos2, params);
      const previewHtml = await this.http.postForm(PASO3_URL, camposLlenos, { charset: 'latin1' });
      preview = this.leerPrevisualizacion(previewHtml, params);
      // Los campos del paso 3 (los que el server devolvió en la previsualización)
      // son los que el paso 4 reenvía. Se parsean del HTML real, no se inventan.
      camposPaso3 = parsearCamposForm(previewHtml);
    } catch (e) {
      throw marcarSeguro(e as Error);
    }

    if (!confirmar) return preview;

    // PASO 4 — EMITE. Desde acá un error NO se marca seguro: el POST pudo salir
    // y la boleta pudo quedar emitida (fail-safe de la ventana de idempotencia).
    const html4 = await this.http.postForm(PASO4_URL, camposPaso3, { charset: 'latin1' });
    const texto4 = textoPlano(html4);
    if (ES_LOGIN.test(html4)) {
      // Ambiguo: la sesión se cayó EN el paso que emite. No afirmar nada.
      throw new Error(
        'La sesión del SII se cayó justo en el paso de emisión: la boleta PUDO o no haberse emitido. '
        + 'Verificá con la lectura de boletas emitidas antes de reintentar.');
    }
    // El folio de la boleta emitida. Se busca por las formas conocidas
    // ("Boleta N° 123"), exigiendo un separador NO alfabético antes del número
    // para que la "o" del símbolo de grado no se pegue a otra palabra.
    const folio = (() => {
      const m = /[Bb]oleta[^0-9]{0,40}N[°º·o]?[\s:.-]+([\d.]+)/.exec(texto4);
      return m ? parseInt(m[1].replace(/\./g, ''), 10) : null;
    })();
    // Una negación/error en la página descarta la emisión SIEMPRE, tenga folio o
    // no: "Boleta N° 1234 no fue emitida" trae un número que NO es un folio
    // asignado. Y sin folio, además hace falta una frase de éxito POSITIVA (un
    // `/emitid/` suelto matchea "no fue emitida", que no alcanza).
    const hayNegacion = /\bno\s+(?:se|fue|pudo|ha)\b|error|problema|rechaz|inconveniente/i.test(texto4);
    const exitoPositivo = /(?:ha sido|fue|se)\s+(?:emitid|generad)\w*\s+(?:con\s+éxito|correctamente|exitosamente)|emitid\w*\s+con\s+éxito/i.test(texto4);
    if (hayNegacion || (folio === null && !exitoPositivo)) {
      // No se afirma la emisión: el mensaje del SII va crudo para diagnóstico.
      // NO se marca seguro (pudo emitirse).
      throw new EscrituraRechazadaPorSii(
        `El SII no confirmó la emisión de la boleta. Respondió: ${texto4.slice(0, 300)}`);
    }
    return {
      emitida: true, folio,
      bruto: montoTras(texto4, /Total\s+Honorarios[^:]*:?/i) ?? preview.bruto,
      retencion: montoTras(texto4, /Retenci[oó]n[^:]*:?/i) ?? preview.retencion,
      liquido: montoTras(texto4, /L[ií]quido[^:]*:?/i) ?? preview.liquido,
      detalle: texto4.slice(0, 800),
    };
  }

  private validarParams(params: EmitirBheParams): void {
    if (params.lineas.length === 0) throw new Error('La boleta necesita al menos una línea de prestación.');
    if (params.lineas.length > MAX_LINEAS) {
      throw new Error(`El portal acepta hasta ${MAX_LINEAS} líneas de prestación; llegaron ${params.lineas.length}.`);
    }
    for (const l of params.lineas) {
      if (!l.descripcion.trim()) throw new Error('Una línea de prestación vino sin descripción.');
      if (!Number.isInteger(l.valor) || l.valor <= 0) {
        throw new Error(`El valor de la línea "${l.descripcion}" debe ser un entero positivo en pesos.`);
      }
    }
    partirRut(params.receptor.rut, 'RUT del receptor');
  }

  // Pasos 1 y 2: valida que el contribuyente pueda emitir, y trae el formulario
  // con TODOS sus campos (defaults del server incluidos).
  private async cargarFormulario(retieneReceptor: boolean): Promise<Record<string, string>> {
    const h1 = await this.http.get(PASO1_URL, { modo: '1' });
    if (ES_LOGIN.test(h1)) {
      throw new Error('La sesión del SII no quedó activa para el portal de BHE (rebotó al login). Reintentá.');
    }
    if (!/OptTipoRetencion/.test(h1)) {
      // El CGI respondió, pero sin la pantalla de retención: es un mensaje de
      // negocio (p.ej. "no registra actividades de segunda categoría").
      throw new EscrituraRechazadaPorSii(
        `El SII no habilitó la emisión de BHE para este RUT: ${textoPlano(h1).slice(0, 250)}`);
    }

    const h2 = await this.http.postForm(PASO2_URL, {
      OptTipoRetencion: retieneReceptor ? 'RETRECEPTOR' : 'RETCONTRIBUYENTE',
    }, { charset: 'latin1' });
    if (ES_LOGIN.test(h2)) {
      throw new Error('La sesión del SII se cayó al cargar el formulario de la boleta. Reintentá.');
    }
    const campos = parsearCamposForm(h2);
    // El formulario real trae el RUT del emisor y el `tiempo` del server. Si no
    // están, esto no es el formulario y no se puede seguir.
    if (!campos.rut_arrastre || !campos.tiempo) {
      throw new Error(
        `El portal no devolvió el formulario de emisión esperado (sin ${!campos.rut_arrastre ? 'rut_arrastre' : 'tiempo'}). `
        + `Respondió: ${textoPlano(h2).slice(0, 250)}`);
    }
    return campos;
  }

  // Propaga los campos del server y sobreescribe SÓLO lo que aporta el emisor.
  private llenarFormulario(campos: Record<string, string>, params: EmitirBheParams): Record<string, string> {
    const { rut, dv } = partirRut(params.receptor.rut, 'RUT del receptor');
    const llenos: Record<string, string> = { ...campos };

    llenos.sin_destinatario = 'NO';
    llenos.txt_rut_destinatario = rut;
    llenos.txt_dv_destinatario = dv;
    llenos.txt_nombres_destinatario = params.receptor.nombre;
    if (params.receptor.direccion) llenos.txt_domicilio_destinatario = params.receptor.direccion;
    if (params.receptor.comuna) llenos.txt_comuna_destinatario = params.receptor.comuna;

    if (params.fecha) {
      const [anio, mes, dia] = params.fecha.split('-');
      llenos.cbo_dia_boleta = String(parseInt(dia, 10));
      llenos.cbo_mes_boleta = String(parseInt(mes, 10));
      llenos.cbo_anio_boleta = anio;
    }

    params.lineas.forEach((l, i) => {
      llenos[`desc_prestacion_${i + 1}`] = l.descripcion;
      // El portal usa separador de miles con punto en el input; se manda el
      // entero pelado, que el CGI acepta (el JS del portal lo formatea, pero el
      // CGI recibe el value).
      llenos[`valor_prestacion_${i + 1}`] = String(l.valor);
    });
    llenos.cantidad_filas_ingreso = String(params.lineas.length);
    return llenos;
  }

  private leerPrevisualizacion(html: string, params: EmitirBheParams): PrevisualizacionBhe {
    if (ES_LOGIN.test(html)) {
      throw new Error('La sesión del SII se cayó al previsualizar la boleta. Reintentá.');
    }
    const texto = textoPlano(html);
    // El paso 3 devuelve el FORMULARIO de vuelta cuando rechaza (mismo patrón
    // que mipyme): si sigue pidiendo los datos en vez de mostrar la boleta, es
    // un rechazo con motivo en el texto.
    if (/OptTipoRetencion|desc_prestacion_1/.test(html) && !/[Vv]ista [Pp]revia|[Cc]onfirmar|[Tt]otal\s+[Hh]onorarios/i.test(texto)) {
      throw new EscrituraRechazadaPorSii(
        `El SII rechazó los datos de la boleta: ${texto.slice(0, 300)}`);
    }
    const bruto = montoTras(texto, /Total\s+Honorarios[^:$]*:?/i);
    const retencion = montoTras(texto, /Retenci[oó]n[^:$]*:?/i);
    const liquido = montoTras(texto, /L[ií]quido[^:$]*:?/i);
    // La previsualización sin ningún monto legible no se entrega como si
    // estuviera bien: el consumidor va a confirmar una emisión sobre esos números.
    if (bruto === null && liquido === null) {
      throw new LimitacionConocida(
        `La previsualización del SII no dejó leer los montos. Texto: ${texto.slice(0, 300)}`);
    }
    return {
      emitida: false, bruto, retencion, liquido,
      receptorRut: params.receptor.rut, receptorNombre: params.receptor.nombre,
      lineas: params.lineas,
      detalle: texto.slice(0, 800),
    };
  }
}
