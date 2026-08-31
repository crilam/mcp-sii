import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RecursoNoEncontrado } from '../erroresConsulta';
import { codificarLong, leerRespuestaGwt, ValorGwt } from './gwtRpc';


// Estado de la declaración F29 de un período y el PDF de su formulario compacto.
//
// La Consulta Integral del SII (`sifmConsultaInternet`) es una app GWT: no tiene
// API legible, habla por GWT-RPC serializado. Capturando con el navegador las
// requests reales (ver `relevarF29Rpc.ts`) quedó claro el camino, que acá se
// reproduce SIN navegador:
//
//   1. POST GWT-RPC `getFoliosConsulta` con rut + formulario + período →
//      devuelve el folio (long) y el `codInt` de la declaración vigente.
//   2. GET `rfiInternet/formCompacto?folio=&rut=&form=029&codInt=` → el PDF.
//
// El `codInt` NO es opcional: sin él, el GET del PDF responde una página de
// error en vez del documento (medido).
//
// FRÁGIL POR DISEÑO DEL SII: el sobre GWT lleva un hash de interfaz y una
// permutación que cambian cuando el SII recompila la app (meses). Están como
// constantes acá, relevadas el 2026-08-29; si el SII responde algo que no es
// `//OK`, el error manda a re-relevar con `relevarF29Rpc.ts`.
const BASE = 'https://www4.sii.cl/sifmConsultaInternet';
const PDF_BASE = 'https://www4.sii.cl/rfiInternet/formCompacto';

// Constantes del sobre GWT relevadas de la captura. `PERMUTACION` y `HASH_SVC`
// son las que cambian con un redeploy de la app.
const PERMUTACION = 'E8E144E2E2983BE000865D9EE574D4C9';
const HASH_SVC = 'E1DE9D75F7AA0CB6A7ABFCB1B0DA8709';
const INTERFAZ = 'cl.sii.sdi.diii.sifmConsulta.web.client.consulta.service.SvcConsulta';

// El F29 en el sistema del SII: aplicación IVAEXP, formulario 29, tipo MES,
// operación DPS (declaración y pago simultáneo).
const APP = 'IVAEXP';
const FORM = '29';

// Campos de AUDITORÍA del sobre (LogAuditoriaDTO): copiados de la captura, el
// servidor los aceptó sin validarlos contra la sesión. Son traza, no identidad:
// aplicación que originó la consulta, canal, e IP de origen (interna del SII).
const AUD_APP = 'DIFM2008_SIFM';
const AUD_COD = '106';
const AUD_NUM = '203';
const AUD_TTL = '3600';
const AUD_IP = '10.20.111.207';

export interface EstadoF29 {
  periodo: number;
  formulario: string;
  folio: number;
  // Identificador interno de la declaración; es el `codInt` que exige el PDF.
  codInt: string;
  estado: string;
  observaciones: string;
  fechaPresentacion: string | null;
  moneda: string;
  // El monto pagado NO se expone: el stream GWT trae varios enteros grandes (id
  // de atención, de envío, y el pago) sin una posición fija fiable, y publicar
  // el equivocado es peor que no publicarlo. Los montos están en el PDF del
  // compacto, que es la fuente que el consumidor usa para eso.
}

// El cuerpo GWT-RPC de `getFoliosConsulta`, capturado LITERAL de una llamada
// real (relevarF29Rpc.ts). Reconstruirlo campo por campo daba
// `IncompatibleRemoteServiceException`: el orden de índices y la tabla de
// strings son exactos y no perdonan. Se usa como plantilla y se sustituye sólo
// lo que cambia entre contribuyentes y períodos:
//   {UNIDAD}  la unidad operativa (string de la tabla)
//   {PERLONG} el período como long GWT (inline en el flujo)
//   {RUTLONG} el RUT como long GWT (inline)
//   {RUT}     el RUT como entero literal (aparece dos veces)
// La IP interna y los códigos de auditoría (DIFM2008_SIFM, 106, 203, 3600, C) se
// dejan como venían: el servidor los aceptó y son campos de traza, no de
// identidad.
const PLANTILLA_GET_FOLIOS =
  `7|0|21|${BASE}/|${HASH_SVC}|${INTERFAZ}|getFoliosConsulta|`
  + 'java.lang.String/2004016611|J|cl.sii.sdi.sifm.commons.to.parser.LogAuditoriaDTO/2405597199|'
  + `${APP}|${FORM}|DPS|Internet|${AUD_COD}|${AUD_APP}|${AUD_NUM}|2|${AUD_IP}|${AUD_TTL}|`
  + 'java.lang.Integer/3438268394|C|{UNIDAD}|java.util.HashMap/1797211028|'
  + '1|2|3|4|7|5|5|6|6|5|5|7|8|9|{PERLONG}|{RUTLONG}|10|11|7|12|13|14|15|15|16|17|18|{RUT}|18|{RUT}|19|20|21|0|';

export function sobreGetFolios(rut: number, periodo: number, unidadOperativa: string): string {
  // La unidad va en la tabla de strings: no puede traer `|` (rompería el sobre).
  // Vacía si no se conoce: es un campo de auditoría y el SII respondió igual sin
  // ella; inventar una unidad ajena sería mentir en la traza.
  const unidad = unidadOperativa.replace(/\|/g, ' ');
  return PLANTILLA_GET_FOLIOS
    .replace('{UNIDAD}', unidad)
    .replace('{PERLONG}', codificarLong(periodo))
    .replace('{RUTLONG}', codificarLong(rut))
    .replace(/\{RUT\}/g, String(rut));
}

// El folio y el codInt de una declaración salen ADYACENTES en el stream (el TO
// serializa sus campos juntos). Un período con rectificatoria trae DOS o más
// declaraciones, y el riesgo es cruzar el folio de una con el codInt de otra:
// eso pediría un PDF equivocado. Se evita tomando el codInt PEGADO al folio, no
// el primero global. El SII ordena la vigente primero (su UI "despliega la
// declaración vigente más reciente"), así que el primer par folio+codInt es esa
// —verificado en vivo—; los demás campos se leen de ese mismo frente del stream.
const ESTADO = /^(Vigente|Anulada|Reemplazada|No Vigente)$/i;

function esFolio(v: ValorGwt): v is number {
  return typeof v === 'number' && v >= 1_000_000_000 && v <= 9_999_999_999;
}

function extraerEstado(stream: ValorGwt[], periodo: number): EstadoF29 {
  // Todos los folios (una por declaración), en orden del stream.
  const posFolios = stream.map((v, i) => (esFolio(v) ? i : -1)).filter(i => i >= 0);
  if (posFolios.length === 0) {
    // Sin folio no hay declaración: puede ser un período sin declarar, y eso se
    // dice como NO_ENCONTRADO, no como un dato a medias.
    throw new RecursoNoEncontrado(
      `El SII no tiene una declaración F29 vigente para el período ${periodo}.`);
  }

  // El SII devuelve la vigente primero: se toma el primer folio y el codInt
  // PEGADO a él (ventana de ±3), para no cruzarlo con el de otra declaración.
  const iFolio = posFolios[0];
  const folio = stream[iFolio] as number;
  const codInt = (() => {
    for (let d = 1; d <= 3; d++) {
      for (const j of [iFolio - d, iFolio + d]) {
        const v = stream[j];
        if (typeof v === 'string' && /^\d{8,9}$/.test(v) && Number(v) !== folio) return v;
      }
    }
    return null;
  })();
  if (codInt === null) {
    throw new RecursoNoEncontrado(
      `El período ${periodo} trae un folio F29 sin su codInt adyacente: no se puede pedir el PDF.`);
  }

  // Estado, obs, fecha y moneda: del frente del stream, que es la vigente.
  const buscar = (re: RegExp) => stream.find((v): v is string => typeof v === 'string' && re.test(v));
  return {
    periodo, formulario: FORM, folio, codInt,
    estado: buscar(ESTADO) ?? 'desconocido',
    observaciones: buscar(/^(SINOBS|CONOBS|OBS)/) ?? '',
    fechaPresentacion: buscar(/^\d{2}\/\d{2}\/\d{4}$/) ?? null,
    moneda: buscar(/^(CLP|USD)$/) ?? 'CLP',
  };
}

export class F29Scraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  private async postGwt(cuerpo: string): Promise<{ stream: ValorGwt[]; tabla: string[] }> {
    const crudo = await this.http.postCrudo(`${BASE}/svcConsulta`, cuerpo, 'text/x-gwt-rpc; charset=utf-8', {
      'X-GWT-Permutation': PERMUTACION,
      'X-GWT-Module-Base': `${BASE}/`,
      Referer: `${BASE}/index.html?dest=cifxx&form=29`,
    });
    return leerRespuestaGwt(crudo);
  }

  /**
   * Estado de la declaración F29 vigente de un período (AAAAMM).
   *
   * `unidadOperativa` es un campo de auditoría del sobre GWT; se toma de la
   * ficha de Mi SII del contribuyente. Con una cadena vacía el SII igual
   * respondió en las pruebas, pero se pasa el valor real por las dudas.
   */
  async estadoDeclaracion(periodo: number, unidadOperativa = ''): Promise<EstadoF29> {
    this.session.assertPuedeEntregarCookieJar();
    const { rut } = this.session.identidad();
    const { stream } = await this.postGwt(
      sobreGetFolios(Number(rut), periodo, unidadOperativa));
    return extraerEstado(stream, periodo);
  }

  /**
   * PDF del formulario compacto de una declaración, por su folio y codInt (los
   * dos que devuelve `estadoDeclaracion`).
   */
  async pdfCompacto(folio: number, codInt: string): Promise<Buffer> {
    this.session.assertPuedeEntregarCookieJar();
    const { rut } = this.session.identidad();
    const { contenido, contentType } = await this.http.getBinario(PDF_BASE, {
      folio: String(folio), rut: String(rut), form: `0${FORM}`, codInt,
    });
    if (!/application\/pdf/i.test(contentType)) {
      throw new Error(
        `El SII no devolvió un PDF del formulario compacto (folio ${folio}). `
        + `Content-Type: ${contentType || 'sin declarar'}. La declaración pudo no existir.`);
    }
    return contenido;
  }
}
