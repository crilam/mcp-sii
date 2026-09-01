import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EscrituraRechazadaPorSii } from '../erroresConsulta';
import { marcarSeguro } from '../idempotenciaEscritura';
import { parsearCamposPagina, textoPlano } from './bheEmision';
import { partirRut } from '../rut';

// OBSERVACIÓN (rechazo del RECEPTOR) de una BHE recibida (ronda 11). Es la
// operación con que el receptor objeta una boleta que le emitieron. Cadena:
//
//   1. TMBCOC_InformeMensualBheRec.cgi        informe de recibidas del mes
//      (de acá salen nro_boleta y codigobarras; el botón "Observar" del portal
//      postea el form del informe con esos dos campos agregados)
//   2. TMBANU_ListarBheRechazarReceptor.cgi   PREVISUALIZA — la boleta + causas
//   3. TMBANU_RecepcionRespuestaRechazo.cgi   OBSERVA — acto real
//
// Causas del portal (listaCausasRechazo): 1 y 2. `confirmar:false` (default)
// recorre 1→2; `confirmar:true` ejecuta el paso 3.
const BASE = 'https://loa.sii.cl/cgi_IMT';
const OBS1_URL = `${BASE}/TMBCOC_InformeMensualBheRec.cgi`;
const OBS2_URL = `${BASE}/TMBANU_ListarBheRechazarReceptor.cgi`;
const OBS3_URL = `${BASE}/TMBANU_RecepcionRespuestaRechazo.cgi`;

export type CausaObservacion = 1 | 2;

export interface ObservacionPrevisualizada {
  observada: false;
  folio: number;
  causa: CausaObservacion;
  detalle: string;
}

export interface BheObservada {
  observada: true;
  folio: number;
  causa: CausaObservacion;
  detalle: string;
}

const ES_LOGIN = /IngresoRutClave|Ingresar Clave Tributaria|CAutInicio/i;

export class BheObservacionScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  /**
   * Observa (o previsualiza la observación de) una BHE RECIBIDA. `anio`/`mes`
   * ubican la boleta en el informe de recibidas; `folio` es el de la boleta.
   */
  async observar(
    rut: string,
    anio: number,
    mes: number,
    folio: number,
    causa: CausaObservacion,
    confirmar = false
  ): Promise<ObservacionPrevisualizada | BheObservada> {
    this.session.assertPuedeEntregarCookieJar();

    let camposConfirmacion: Record<string, string>;
    let detalle2: string;
    try {
      if (!Number.isInteger(folio) || folio <= 0) throw new Error('El folio a observar debe ser un entero positivo.');
      const { rut: rutNum, dv } = partirRut(rut, 'RUT del receptor autenticado');

      // Paso 1: el informe de recibidas del mes, para el codigobarras del folio.
      const h1 = await this.http.postForm(OBS1_URL, {
        rut_arrastre: rutNum, dv_arrastre: dv, pagina_solicitada: '1',
        cbmesinformemensual: String(mes).padStart(2, '0'),
        cbanoinformemensual: String(anio),
      }, { charset: 'latin1' });
      if (ES_LOGIN.test(h1)) throw new Error('La sesión del SII no quedó activa para el informe de recibidas. Reintentá.');
      // El informe llega como arrays JS: nroboleta_i / codigobarras_i.
      let codigoBarras: string | null = null;
      for (const m of h1.matchAll(/arr_informe_mensual\['nroboleta_(\d+)'\]\s*=\s*"(\d+)"/g)) {
        if (parseInt(m[2], 10) === folio) {
          codigoBarras = new RegExp(`arr_informe_mensual\\['codigobarras_${m[1]}'\\]\\s*=\\s*"([A-Za-z0-9]+)"`).exec(h1)?.[1] ?? null;
          break;
        }
      }
      if (!codigoBarras) {
        throw new EscrituraRechazadaPorSii(
          `La boleta ${folio} no aparece en el informe de recibidas de ${String(mes).padStart(2, '0')}/${anio}. `
          + 'Verificá el período con la lectura de recibidas.');
      }

      // Paso 2: la previsualización con las causas (replica el POST que arma
      // ValidarObservarMensual: el form del informe + nro_boleta + codigobarras).
      const campos1 = parsearCamposPagina(h1);
      const h2 = await this.http.postForm(OBS2_URL, {
        ...campos1,
        nro_boleta: String(folio),
        txt_codigobarras: codigoBarras,
      }, { charset: 'latin1' });
      if (ES_LOGIN.test(h2)) throw new Error('La sesión del SII se cayó al preparar la observación. Reintentá.');
      detalle2 = textoPlano(h2);
      if (!/ConfirmarRespuestaRechazo|listaCausasRechazo/i.test(h2)) {
        throw new EscrituraRechazadaPorSii(
          `El SII no aceptó observar la boleta ${folio}: ${detalle2.slice(0, 300)}`);
      }
      // La página lista TODAS las boletas observables como filas indexadas:
      // hidden nroboleta_i (valor en arr_informe_anu), checkbox chkRechazo_i y
      // select cbRechazo_i (causas por listaCausasRechazo). Los names llevan el
      // índice concatenado por JS, así que se reconstruyen acá: se marca SÓLO
      // la fila del folio pedido, el resto viaja sin check y con causa vacía
      // (fidelidad con lo que postea el navegador).
      const filas = [...h2.matchAll(/arr_informe_anu\['nroboleta_(\d+)'\]\s*=\s*"(\d+)"/g)];
      const fila = filas.find(f => parseInt(f[2], 10) === folio);
      if (!fila) {
        throw new EscrituraRechazadaPorSii(
          `La boleta ${folio} no está entre las observables del período: ${detalle2.slice(0, 250)}`);
      }
      camposConfirmacion = parsearCamposPagina(h2);
      for (const f of filas) {
        camposConfirmacion[`nroboleta_${f[1]}`] = f[2];
        if (f !== fila) camposConfirmacion[`cbRechazo_${f[1]}`] = '';
      }
      camposConfirmacion[`chkRechazo_${fila[1]}`] = 'on';
      camposConfirmacion[`cbRechazo_${fila[1]}`] = String(causa);
    } catch (e) {
      throw marcarSeguro(e as Error);
    }

    if (!confirmar) return { observada: false, folio, causa, detalle: detalle2.slice(0, 800) };

    // Paso 3 — OBSERVA. Un error acá no se marca seguro.
    const h3 = await this.http.postForm(OBS3_URL, camposConfirmacion, { charset: 'latin1' });
    const texto3 = textoPlano(h3);
    if (ES_LOGIN.test(h3)) {
      throw new Error(
        'La sesión del SII se cayó justo en el paso que observa: la boleta PUDO o no quedar observada. '
        + 'Verificá con la lectura de recibidas antes de reintentar.');
    }
    const hayNegacion = /\bno\s+(?:se|fue|pudo|ha)\b|error|problema|rechaz\w*\s+su\s+solicitud|inconveniente/i.test(texto3);
    // El wizard de observación tiene DOS pasos ("Paso 1 de 2" es la página de
    // causas): la final es "Paso 2 de 2".
    const exitoPositivo = /observad\w*|ha\s+sido\s+registrad|Paso 2 de 2/i.test(texto3);
    if (hayNegacion || !exitoPositivo) {
      throw new EscrituraRechazadaPorSii(
        `El SII no confirmó la observación de la boleta ${folio}. Respondió: ${texto3.slice(0, 300)}. `
        + 'ANTES de reintentar, verificá con la lectura de recibidas.');
    }
    return { observada: true, folio, causa, detalle: texto3.slice(0, 800) };
  }
}
