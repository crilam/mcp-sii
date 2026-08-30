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
// constantes acá, relevadas el 2026-08-30; si el SII responde algo que no es
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
  + `${APP}|${FORM}|DPS|Internet|106|DIFM2008_SIFM|203|2|10.20.111.207|3600|`
  + 'java.lang.Integer/3438268394|C|{UNIDAD}|java.util.HashMap/1797211028|'
  + '1|2|3|4|7|5|5|6|6|5|5|7|8|9|{PERLONG}|{RUTLONG}|10|11|7|12|13|14|15|15|16|17|18|{RUT}|18|{RUT}|19|20|21|0|';

export function sobreGetFolios(rut: number, periodo: number, unidadOperativa: string): string {
  // La unidad va en la tabla de strings: no puede traer `|` (rompería el sobre).
  const unidad = (unidadOperativa || 'SANTIAGO ORIENTE').replace(/\|/g, ' ');
  return PLANTILLA_GET_FOLIOS
    .replace('{UNIDAD}', unidad)
    .replace('{PERLONG}', codificarLong(periodo))
    .replace('{RUTLONG}', codificarLong(rut))
    .replace(/\{RUT\}/g, String(rut));
}

// Del stream ya decodificado se leen los campos por FORMA, no por posición
// exacta: la posición dentro del TO puede correrse con un cambio menor de la
// app, pero un folio F29 es un número de 10 dígitos, el codInt un string de 8-9
// dígitos, la fecha `dd/mm/yyyy`. Se valida cada uno.
function extraerEstado(stream: ValorGwt[], tabla: string[], periodo: number): EstadoF29 {
  const numeros = stream.filter((v): v is number => typeof v === 'number');
  const folio = numeros.find(n => n >= 1_000_000_000 && n <= 9_999_999_999) ?? null;

  const sololDigitos = (s: string) => /^\d+$/.test(s);
  const codInt = tabla.find(s => sololDigitos(s) && s.length >= 8 && s.length <= 9 && Number(s) !== folio) ?? null;

  if (folio === null || codInt === null) {
    // Sin folio ni codInt no hay declaración que apuntar: puede ser un período
    // sin declarar, y eso se dice como NO_ENCONTRADO, no como un dato a medias.
    throw new RecursoNoEncontrado(
      `El SII no tiene una declaración F29 vigente para el período ${periodo}.`);
  }

  const estado = tabla.find(s => /^(Vigente|Anulada|Reemplazada|No Vigente)$/i.test(s)) ?? '';
  const observaciones = tabla.find(s => /^(SINOBS|CONOBS|OBS)/.test(s)) ?? '';
  const fecha = tabla.find(s => /^\d{2}\/\d{2}\/\d{4}$/.test(s)) ?? null;
  const moneda = tabla.find(s => /^(CLP|USD)$/.test(s)) ?? 'CLP';

  return {
    periodo, formulario: FORM, folio, codInt,
    estado: estado || 'desconocido', observaciones,
    fechaPresentacion: fecha, moneda,
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
    const { stream, tabla } = await this.postGwt(
      sobreGetFolios(Number(rut), periodo, unidadOperativa));
    return extraerEstado(stream, tabla, periodo);
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
