import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EscrituraRechazadaPorSii } from '../erroresConsulta';
import { marcarSeguro } from '../idempotenciaEscritura';
import { parsearCamposPagina, parsearXmlValues, textoPlano } from './bheEmision';

// REENVÍO por email de una BHE emitida (ronda 11). Dos pasos:
//
//   1. GET  TMBCOT_PresentaDatosEnvio.cgi?txt_codigobarras=...&veroriginal=si
//           &origen=CUARTO&enviar=si         form con el email del receptor
//   2. POST TMBCOT_ConsultaBoletaPdf.cgi     ENVÍA el email (mismo CGI del PDF;
//           el form del paso 1 viaja con origen=QUINTO y txt_email)
//
// El identificador es el CÓDIGO DE BARRAS de la boleta (el mismo del PDF), no
// el folio. `confirmar:false` (default) recorre sólo el paso 1 y devuelve el
// email al que el portal enviaría; `confirmar:true` ejecuta el paso 2.
const BASE = 'https://loa.sii.cl/cgi_IMT';
const ENVIO1_URL = `${BASE}/TMBCOT_PresentaDatosEnvio.cgi`;
const ENVIO2_URL = `${BASE}/TMBCOT_ConsultaBoletaPdf.cgi`;

export interface EnvioPrevisualizado {
  enviado: false;
  codigoBarras: string;
  // El email que el portal tiene precargado para el receptor (puede ser '').
  emailPortal: string;
  // El email al que se enviaría (el pedido, o el del portal si no se pidió).
  emailDestino: string;
  detalle: string;
}

export interface BheEnviada {
  enviado: true;
  codigoBarras: string;
  emailDestino: string;
  detalle: string;
}

const ES_LOGIN = /IngresoRutClave|Ingresar Clave Tributaria|CAutInicio/i;
const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Compartida con schemaEmailBhe (core/schemas/bhe.ts): si el formato del
// código de barras cambia, actualizar ambos o extraer a un módulo común.
export const CODIGO_BARRAS_VALIDO = /^[A-Za-z0-9]{10,30}$/;

export class BheEmailScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  /**
   * Reenvía (o previsualiza el reenvío de) una BHE por email. `email` es el
   * destinatario; si se omite, va el que el portal tiene para el receptor.
   */
  async enviar(codigoBarras: string, email: string | undefined, confirmar = false): Promise<EnvioPrevisualizado | BheEnviada> {
    this.session.assertPuedeEntregarCookieJar();

    let campos: Record<string, string>;
    let emailDestino: string;
    let emailPortal: string;
    try {
      if (!CODIGO_BARRAS_VALIDO.test(codigoBarras)) {
        throw new Error('El código de barras de la boleta no tiene la forma esperada (alfanumérico, ~20 caracteres).');
      }
      if (email !== undefined && !EMAIL_VALIDO.test(email)) {
        throw new Error(`El email de destino no es válido: ${email}`);
      }
      const h1 = await this.http.get(ENVIO1_URL, {
        txt_codigobarras: codigoBarras, veroriginal: 'si', origen: 'CUARTO', enviar: 'si',
      });
      if (ES_LOGIN.test(h1)) {
        throw new Error('La sesión del SII no quedó activa para el portal de BHE (rebotó al login). Reintentá.');
      }
      if (!/txt_email/.test(h1)) {
        // El CGI respondió sin el form de envío: boleta inexistente/ajena o
        // mensaje de negocio.
        throw new EscrituraRechazadaPorSii(
          `El SII no ofreció el envío por email para esa boleta: ${textoPlano(h1).slice(0, 250)}`);
      }
      campos = parsearCamposPagina(h1);
      // El email precargado lo asigna el JS (txt_email arranca vacío en el
      // tag): vive en xml_values['email'].
      emailPortal = parsearXmlValues(h1)['email'] || campos.txt_email || '';
      emailDestino = email ?? emailPortal;
      if (!EMAIL_VALIDO.test(emailDestino)) {
        throw new EscrituraRechazadaPorSii(
          'El portal no tiene un email del receptor y no se indicó uno: no hay destinatario para el envío.');
      }
      campos.txt_email = emailDestino;
    } catch (e) {
      throw marcarSeguro(e as Error);
    }

    if (!confirmar) {
      return { enviado: false, codigoBarras, emailPortal, emailDestino, detalle: 'Previsualización: no se envió ningún email.' };
    }

    // PASO 2 — ENVÍA. Un error acá no se marca seguro: el email pudo salir.
    const h2 = await this.http.postForm(ENVIO2_URL, campos, { charset: 'latin1' });
    const texto2 = textoPlano(h2);
    if (ES_LOGIN.test(h2)) {
      throw new Error('La sesión del SII se cayó en el paso que envía: el email PUDO o no haber salido.');
    }
    const hayNegacion = /\bno\s+(?:se|fue|pudo|ha)\b|error|problema|rechaz|inconveniente/i.test(texto2);
    // Sólo la frase de confirmación real cuenta como éxito: un patrón laxo
    // (p.ej. la palabra "e-mail" del label) matchearía el form re-mostrado.
    const exitoPositivo = /enviad/i.test(texto2);
    if (hayNegacion || !exitoPositivo) {
      throw new EscrituraRechazadaPorSii(
        `El SII no confirmó el envío del email. Respondió: ${texto2.slice(0, 300)}`);
    }
    return { enviado: true, codigoBarras, emailDestino, detalle: texto2.slice(0, 500) };
  }
}
