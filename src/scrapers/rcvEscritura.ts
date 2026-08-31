import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { LimitacionConocida, EscrituraRechazadaPorSii } from '../erroresConsulta';
import { partirRut } from '../rut';

// PRIMERA operación de ESCRITURA del servicio (ronda 11): el acuse de recibo de
// documentos del RCV (`ingresarAceptacionReclamoDocs`). Fija el guardrail que el
// resto de la escritura reutiliza:
//
//  - Toda operación lleva `confirmar` (default false). Con false NO muta: valida
//    y devuelve qué HARÍA. Con true ejecuta el acto real contra el SII.
//  - Un acuse de recibo NO es cosmético: bajo la Ley 19.983 habilita la cesión
//    del crédito del documento. Es un acto real, y por eso pasa por el guardrail.
//
// Relevado del bundle `consdcvinternetui` y verificado el catálogo en vivo:
// getEventosDoc devuelve en `dataEventosDocs` los códigos válidos (ERM, ERG).
const BASE = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';
const NAMESPACE = 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';

export interface EventoAcuse {
  codigo: string;       // dedCodEvento, ej. 'ERM'
  descripcion: string;  // dedDescEvento
}

// Un documento a acusar: RUT del emisor del documento, su tipo y su folio.
export interface DocumentoAcuse {
  rutEmisor: string;    // con dígito verificador, 22222222-2
  tipoDoc: number;
  folio: number;
}

export interface ResultadoAcuse {
  // false = fue una simulación (confirmar:false), no se acusó nada.
  ejecutado: boolean;
  evento: string;
  documentos: DocumentoAcuse[];
  // Mensaje del SII (sólo cuando se ejecuta). En simulación, qué se haría.
  mensaje: string;
}

// El catálogo de eventos es casi estático; se cachea por proceso unos minutos
// para no golpear getEventosDoc en CADA escritura (incluso en los dry-run).
const CATALOGO_TTL_MS = 5 * 60_000;
let catalogoCache: { ts: number; eventos: EventoAcuse[] } | null = null;

/** Limpia el cache del catálogo. Sólo para tests. */
export function _resetCatalogoAcuse(): void {
  catalogoCache = null;
}

export class RcvEscrituraScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  /** Catálogo de eventos de acuse válidos (lectura, cacheado por proceso). */
  async eventosAcuse(): Promise<EventoAcuse[]> {
    this.session.assertPuedeEntregarCookieJar();
    if (catalogoCache && Date.now() - catalogoCache.ts < CATALOGO_TTL_MS) return catalogoCache.eventos;
    const resp = await this.http.postSdi(BASE, NAMESPACE, 'getEventosDoc', {}) as
      { respEstado?: { codRespuesta?: number }; dataEventosDocs?: { dedCodEvento: string; dedDescEvento: string }[] };
    const cod = resp?.respEstado?.codRespuesta;
    if (cod !== 0) {
      throw new Error(`El SII respondió código ${cod} al pedir el catálogo de eventos de acuse del RCV.`);
    }
    const eventos = (resp.dataEventosDocs ?? []).map(e => ({ codigo: e.dedCodEvento, descripcion: e.dedDescEvento.replace(/\s+/g, ' ').trim() }));
    catalogoCache = { ts: Date.now(), eventos };
    return eventos;
  }

  /**
   * Acusa recibo de uno o más documentos. Con `confirmar:false` (default) NO
   * llama al SII para mutar: valida el evento contra el catálogo y los documentos,
   * y devuelve la simulación. Con `confirmar:true` cursa el acuse
   * (`ingresarAceptacionReclamoDocs`) — acto real e irreversible.
   */
  async acusar(documentos: DocumentoAcuse[], evento: string, confirmar: boolean): Promise<ResultadoAcuse> {
    this.session.assertPuedeEntregarCookieJar();
    if (documentos.length === 0) {
      throw new Error('No se indicó ningún documento para acusar recibo.');
    }

    // El evento tiene que estar en el catálogo del SII: un código inventado no se
    // manda a ciegas a una operación de escritura.
    const catalogo = await this.eventosAcuse();
    if (!catalogo.some(e => e.codigo === evento)) {
      throw new LimitacionConocida(
        `El evento de acuse "${evento}" no está en el catálogo del SII (${catalogo.map(e => e.codigo).join(', ') || 'vacío'}). `
        + 'Consultá los eventos válidos antes de acusar.');
    }

    // Se arma el payload SIEMPRE (para poder mostrarlo en la simulación), pero
    // sólo se envía si confirmar es true.
    const dteAcuRe = documentos.map(d => {
      const { rut, dv } = partirRut(d.rutEmisor, 'RUT del emisor del documento');
      return { detRutDoc: rut, detDvDoc: dv, detTipoDoc: d.tipoDoc, detNroDoc: d.folio, dedCodEvento: evento };
    });

    if (!confirmar) {
      return {
        ejecutado: false, evento, documentos,
        mensaje: `Simulación: se acusaría "${evento}" sobre ${documentos.length} documento(s). `
          + 'Volvé a llamar con confirmar:true para cursar el acuse real.',
      };
    }

    const { rut: rutAut, dv: dvAut } = this.session.identidad();
    const resp = await this.http.postSdi(BASE, NAMESPACE, 'ingresarAceptacionReclamoDocs', {
      dteAcuRe, rutAutenticado: rutAut, dvAutenticado: dvAut,
    }) as { respEstado?: { codRespuesta?: number; msgeRespuesta?: string } };

    const cod = resp?.respEstado?.codRespuesta;
    const msg = resp?.respEstado?.msgeRespuesta ?? '';
    // 0 = OK. 100 = alerta del SII (no cursó, o cursó con reparos): se reporta
    // como limitación conocida con el mensaje del SII, no como éxito. Cualquier
    // otro código es un error.
    if (cod === 100) {
      throw new LimitacionConocida(`El SII no cursó el acuse: ${msg || 'sin detalle'}.`);
    }
    if (cod !== 0) {
      // No es un bug del servicio: el SII rechazó el acto. Se reporta como tal
      // (RECHAZO_SII) con su mensaje, no como error interno.
      throw new EscrituraRechazadaPorSii(`El SII rechazó el acuse (código ${cod})${msg ? `: ${msg}` : '.'}`);
    }
    return { ejecutado: true, evento, documentos, mensaje: msg || 'Acuse cursado.' };
  }
}
