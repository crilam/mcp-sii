import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EscrituraRechazadaPorSii } from '../erroresConsulta';
import { marcarSeguro } from '../idempotenciaEscritura';
import { parsearCamposPagina, parsearXmlValues } from './bheEmision';

// ANULACIÓN de una BHE emitida (ronda 11). Cadena CGI del portal, el mismo
// patrón de wizard por campos ocultos que la emisión (ver bheEmision.ts):
//
//   1. TMBANU_PrevalidaAnulacion.cgi   form: N° de boleta + causa (GET)
//   2. TMBANU_ConfirmarAnulacion.cgi   PREVISUALIZA la anulación — NO anula
//   3. TMBANU_RecepcionAnulacion.cgi   ANULA — acto real e irreversible
//
// `confirmar:false` (default) recorre 1→2 y devuelve lo que el SII va a anular;
// `confirmar:true` ejecuta el paso 3.
const BASE = 'https://loa.sii.cl/cgi_IMT';
const ANU1_URL = `${BASE}/TMBANU_PrevalidaAnulacion.cgi`;
const ANU2_URL = `${BASE}/TMBANU_ConfirmarAnulacion.cgi`;
const ANU3_URL = `${BASE}/TMBANU_RecepcionAnulacion.cgi`;

// Causas que ofrece el portal (relevadas del form real):
//   1 = no se efectuó el pago de los servicios por parte del receptor
//   2 = no se efectuó la prestación de servicios
//   3 = error en la digitación
export type CausaAnulacion = 1 | 2 | 3;

export interface AnulacionPrevisualizada {
  anulada: false;
  folio: number;
  causa: CausaAnulacion;
  detalle: string;
}

export interface BheAnulada {
  anulada: true;
  folio: number;
  causa: CausaAnulacion;
  detalle: string;
}

const ES_LOGIN = /IngresoRutClave|Ingresar Clave Tributaria|CAutInicio/i;

function textoPlano(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class BheAnulacionScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  async anular(folio: number, causa: CausaAnulacion, confirmar = false): Promise<AnulacionPrevisualizada | BheAnulada> {
    this.session.assertPuedeEntregarCookieJar();

    // FASE PRE-ANULACIÓN (pasos 1-2): no muta nada, los errores son seguros
    // de liberar para la ventana de idempotencia.
    let camposConfirmacion: Record<string, string>;
    let detalle2: string;
    try {
      if (!Number.isInteger(folio) || folio <= 0) throw new Error('El folio a anular debe ser un entero positivo.');
      const h1 = await this.http.get(ANU1_URL);
      if (ES_LOGIN.test(h1)) throw new Error('La sesión del SII no quedó activa para el portal de BHE (rebotó al login). Reintentá.');
      if (!/Txt_BoletaAnular/.test(h1)) {
        throw new EscrituraRechazadaPorSii(
          `El SII no habilitó la anulación de BHE para este RUT: ${textoPlano(h1).slice(0, 250)}`);
      }
      const xml1 = parsearXmlValues(h1);
      if (!xml1['rut_autentificado']) throw new Error('El form de anulación no trajo el RUT autenticado (xml_values).');

      const h2 = await this.http.postForm(ANU2_URL, {
        rut_arrastre: xml1['rut_autentificado'],
        dv_arrastre: xml1['dv_autentificado'] ?? '',
        origen: 'SEXTO',
        Txt_BoletaAnular: String(folio),
        OptCausaAnulacion: String(causa),
      }, { charset: 'latin1' });
      if (ES_LOGIN.test(h2)) throw new Error('La sesión del SII se cayó al confirmar la anulación. Reintentá.');
      detalle2 = textoPlano(h2);
      // La página de confirmación trae el botón "Confirmar Anulación"
      // (onclick ConfirmarAnulacion(), que llama presionaBoton
      // ('confirmar_anulacion')); si en cambio vuelve el form pidiendo la
      // boleta, o un mensaje de negocio ("boleta no existe", "ya se encuentra
      // anulada"), es un rechazo.
      if (!/ConfirmarAnulacion/.test(h2)) {
        throw new EscrituraRechazadaPorSii(
          `El SII no aceptó anular la boleta ${folio}: ${detalle2.slice(0, 300)}`);
      }
      camposConfirmacion = parsearCamposPagina(h2);
    } catch (e) {
      throw marcarSeguro(e as Error);
    }

    if (!confirmar) return { anulada: false, folio, causa, detalle: detalle2.slice(0, 800) };

    // PASO 3 — ANULA. Desde acá un error NO se marca seguro: el POST pudo salir
    // y la boleta pudo quedar anulada.
    const h3 = await this.http.postForm(ANU3_URL, camposConfirmacion, { charset: 'latin1' });
    const texto3 = textoPlano(h3);
    if (ES_LOGIN.test(h3)) {
      throw new Error(
        'La sesión del SII se cayó justo en el paso que anula: la boleta PUDO o no quedar anulada. '
        + 'Verificá con la lectura de boletas emitidas antes de reintentar.');
    }
    const hayNegacion = /\bno\s+(?:se|fue|pudo|ha)\b|error|problema|rechaz|inconveniente/i.test(texto3);
    // Éxito: frase positiva, la página final del wizard ("Paso 3 de 3", que se
    // renderiza por JS y deja el texto plano casi vacío — forma real de la
    // primera anulación verificada), o los datos de la boleta en xml_values.
    const exitoPositivo = /anulad\w*\s+(?:con\s+éxito|correctamente|exitosamente)|ha\s+sido\s+anulad/i.test(texto3)
      || /Paso 3 de 3/i.test(texto3)
      || 'Monto_Boleta' in parsearXmlValues(h3);
    if (hayNegacion || !exitoPositivo) {
      throw new EscrituraRechazadaPorSii(
        `El SII no confirmó la anulación de la boleta ${folio}. Respondió: ${texto3.slice(0, 300)}. `
        + 'ANTES de reintentar, verificá con la lectura de emitidas: la boleta pudo quedar anulada.');
    }
    return { anulada: true, folio, causa, detalle: texto3.slice(0, 800) };
  }
}
