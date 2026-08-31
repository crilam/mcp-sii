import * as zlib from 'zlib';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RecursoNoEncontrado, LimitacionConocida } from '../erroresConsulta';
import { partirRut } from '../rut';
import { OperacionRcv } from './rcv';

// Descarga ASÍNCRONA del detalle del RCV. El detalle síncrono (getDetalleCompra/
// Venta) tiene un techo: el SII no garantiza más allá de ~393 documentos y el
// transporte corta a 4 MiB. Para períodos grandes el portal usa otro camino,
// relevado del bundle `consdcvinternetui/app.full.min.js` y verificado en vivo:
//
//   1. getCtrlAsync con `generaCtrl:true`  → CREA la solicitud (sin reCAPTCHA:
//      el token va vacío y el SII igual la acepta). Devuelve caId, caEstado.
//   2. getCtrlAsync con `generaCtrl:false` → POLL. caEstado evoluciona
//      CREADO → EN PROCESO → TERMINADO, y al terminar trae el caIdBLOB real.
//   3. GET obtenerArchivoBLOB/{caIdBLOB}/{usuario}/{rutEmisor}/{caId} → un
//      .csv.gz con las 26 columnas del detalle.
//
// El estado se expone TAL CUAL lo da el SII (sin enum propio): el consumidor
// hace su propio polling contra `/async/estado` y descarga cuando esté
// `TERMINADO`. El servicio no persiste nada; el SII es el dueño del estado.
const BASE = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';
const NAMESPACE = 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';
const ESTADO_CONTAB = 'REGISTRO';

// Estados del control async, tal como los emite el SII. La descarga se habilita
// sólo en TERMINADO; el resto son transitorios.
export const ESTADO_TERMINADO = 'TERMINADO';
const BLOB_VACIO = 'SIN-BLOB';

const PERIODO_VALIDO = /^\d{4}(0[1-9]|1[0-2])$/;

export interface SolicitudAsyncRcv {
  // Id del control de la solicitud en el SII (caId). Identifica esta solicitud.
  solicitudId: number;
  // Id del archivo generado (caIdBLOB); `null` mientras no está TERMINADO.
  blobId: string | null;
  periodo: number;
  tipoDocCodigo: number;
  operacion: OperacionRcv;
  // Estado CRUDO del SII: 'CREADO' | 'EN PROCESO' | 'TERMINADO' (u otro que el
  // SII agregue). No se traduce a un enum propio a propósito.
  estado: string;
  // Conveniencia: `estado === 'TERMINADO'`. El string sigue siendo la verdad.
  terminada: boolean;
  // Cantidad de registros del archivo (caNumLineas). Es el control de resultado
  // conocido: al descargar, las filas parseadas deben coincidir con esto.
  registros: number;
  tamanoBytes: number;
  // Marcas de tiempo del SII, crudas (DD/MM/AAAA HH:mm:ss), `null` si no aplica.
  creadoEn: string | null;
  enProcesoEn: string | null;
  terminadoEn: string | null;
  // Descripción de error del propio SII, si la solicitud falló.
  error: string | null;
}

export interface DetalleAsyncRcv {
  periodo: number;
  operacion: OperacionRcv;
  tipoDocCodigo: number;
  solicitudId: number;
  // Cantidad de DOCUMENTOS (valores distintos de la columna "Nro"). Puede ser
  // menor que `filas.length`: un documento con otros impuestos ocupa varias
  // filas del CSV. Coincide con los registros que el SII declaró.
  totalDocumentos: number;
  // Encabezados EXACTOS del CSV del SII, en orden. Se conservan crudos: son la
  // definición de cada columna según el SII.
  columnas: string[];
  // Una fila del CSV (no siempre un documento: ver totalDocumentos). Claves =
  // `columnas`; valores tal como vienen en el CSV (string), SIN reinterpretar
  // tipos: convertir un monto o un código acá es justo donde se cuela un dato
  // plausible pero equivocado. El consumidor sabe qué columna es número.
  filas: Record<string, string>[];
}

/** Deriva COMPRA/VENTA del `caProceso` del SII (…_C_… / …_V_…). */
function operacionDe(caProceso: unknown, porDefecto: OperacionRcv): OperacionRcv {
  const m = /_([CV])_/.exec(String(caProceso ?? ''));
  if (m) return m[1] === 'C' ? 'COMPRA' : 'VENTA';
  return porDefecto;
}

function normalizar(fila: any, operacionPedida: OperacionRcv): SolicitudAsyncRcv {
  const blob = fila?.caIdBLOB;
  const estado = String(fila?.caEstado ?? '');
  return {
    solicitudId: Number(fila?.caId),
    blobId: blob && blob !== BLOB_VACIO ? String(blob) : null,
    periodo: Number(fila?.caPeriodo),
    tipoDocCodigo: Number(fila?.caTipoDoc),
    operacion: operacionDe(fila?.caProceso, operacionPedida),
    estado,
    terminada: estado === ESTADO_TERMINADO,
    registros: Number(fila?.caNumLineas ?? 0),
    tamanoBytes: Number(fila?.caFileSize ?? 0),
    creadoEn: fila?.caTmstCreado ?? null,
    enProcesoEn: fila?.caTmstEnProceso ?? null,
    terminadoEn: fila?.caTmstTerminado ?? null,
    error: fila?.caDescError ?? null,
  };
}

// El CSV del SII usa `;` como separador y una cabecera en la primera línea. Sus
// campos no traen `;` internos (RUT, montos, razones sociales sin puntuación
// rara), así que un split directo alcanza; igual se valida que cada fila tenga
// tantas columnas como la cabecera, para que un formato inesperado falle en vez
// de producir filas corridas.
function parsearCsv(texto: string): { columnas: string[]; filas: Record<string, string>[] } {
  const lineas = texto.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lineas.length === 0) throw new Error('El archivo del SII vino vacío (sin cabecera).');
  const columnas = lineas[0].split(';').map(c => c.trim());
  const filas: Record<string, string>[] = [];
  for (let i = 1; i < lineas.length; i++) {
    let celdas = lineas[i].split(';');
    // El SII cierra cada fila con `;`, así que trae una celda vacía de más. Se
    // descarta sólo si es exactamente esa: una columna extra CON contenido sería
    // un cambio de formato real y debe fallar.
    if (celdas.length === columnas.length + 1 && celdas[celdas.length - 1].trim() === '') {
      celdas = celdas.slice(0, -1);
    }
    if (celdas.length !== columnas.length) {
      throw new Error(
        `Fila ${i} del detalle RCV tiene ${celdas.length} columnas y la cabecera ${columnas.length}: `
        + 'el formato del CSV del SII cambió, no se parsea a ciegas.');
    }
    const fila: Record<string, string> = {};
    columnas.forEach((c, j) => { fila[c] = celdas[j].trim(); });
    filas.push(fila);
  }
  return { columnas, filas };
}

export class RcvAsyncScraper {
  constructor(private http: SiiHttpClient, private session: SessionManager) {}

  private rutEmpresa(empresaRut?: string): { rut: string; dv: string } {
    this.session.assertPuedeEntregarCookieJar();
    return empresaRut ? partirRut(empresaRut, 'RUT de empresa') : this.session.identidad();
  }

  private dataCtrl(rut: string, dv: string, periodo: string, tipoDoc: string, operacion: OperacionRcv, generaCtrl: boolean) {
    // Mismos campos que manda el portal. reCAPTCHA vacío: el SII lo acepta.
    return {
      rutEmisor: rut, dvEmisor: dv, ptributario: periodo, codTipoDoc: tipoDoc,
      generaCtrl, operacion, estadoContab: ESTADO_CONTAB, totDoc: 0,
      accionRecaptcha: '', tokenRecaptcha: '',
    };
  }

  // Del arreglo que devuelve getCtrlAsync, las solicitudes de ESE período,
  // tipo de documento y operación, más nuevas primero.
  private filtrar(resp: any, periodo: string, tipoDoc: string, operacion: OperacionRcv): SolicitudAsyncRcv[] {
    const cod = resp?.respEstado?.codRespuesta;
    // 0 y 1 son las respuestas con datos del control async (1 trae además un
    // aviso en msgeRespuesta). Cualquier otro código no es "sin solicitudes":
    // es un problema que no se puede leer como vacío.
    if (cod !== 0 && cod !== 1) {
      throw new Error(
        `El SII respondió código ${cod} al control asíncrono del RCV`
        + (resp?.respEstado?.msgeRespuesta ? `: ${resp.respEstado.msgeRespuesta}` : '.'));
    }
    const filas: any[] = Array.isArray(resp?.data) ? resp.data : [];
    return filas
      .map(f => normalizar(f, operacion))
      .filter(s => s.periodo === Number(periodo) && s.tipoDocCodigo === Number(tipoDoc) && s.operacion === operacion)
      .sort((a, b) => b.solicitudId - a.solicitudId);
  }

  private validarPeriodo(periodo: string) {
    if (!PERIODO_VALIDO.test(periodo)) {
      throw new Error(`El período "${periodo}" no tiene forma de AAAAMM (ej. 202601).`);
    }
  }

  /** Crea la solicitud (generaCtrl:true) y devuelve su estado inicial. */
  async solicitar(periodo: string, operacion: OperacionRcv, tipoDocCodigo: number, empresaRut?: string): Promise<SolicitudAsyncRcv> {
    this.validarPeriodo(periodo);
    const { rut, dv } = this.rutEmpresa(empresaRut);
    const tipoDoc = String(tipoDocCodigo);
    const resp = await this.http.postSdi(BASE, NAMESPACE, 'getCtrlAsync', this.dataCtrl(rut, dv, periodo, tipoDoc, operacion, true));
    const propias = this.filtrar(resp, periodo, tipoDoc, operacion);
    if (propias.length === 0) {
      throw new Error('El SII aceptó la solicitud asíncrona pero no devolvió su control: no se puede seguir el estado.');
    }
    return propias[0];
  }

  /** Poll (generaCtrl:false): las solicitudes de esa combinación, con su estado. */
  async estado(periodo: string, operacion: OperacionRcv, tipoDocCodigo: number, empresaRut?: string): Promise<SolicitudAsyncRcv[]> {
    this.validarPeriodo(periodo);
    const { rut, dv } = this.rutEmpresa(empresaRut);
    const tipoDoc = String(tipoDocCodigo);
    const resp = await this.http.postSdi(BASE, NAMESPACE, 'getCtrlAsync', this.dataCtrl(rut, dv, periodo, tipoDoc, operacion, false));
    return this.filtrar(resp, periodo, tipoDoc, operacion);
  }

  /**
   * Descarga y parsea el detalle de la solicitud TERMINADA más reciente de esa
   * combinación. Sin solicitudes → NO_ENCONTRADO. Con solicitudes pero ninguna
   * terminada → LimitacionConocida "en proceso" (el consumidor reintenta).
   */
  async detalle(periodo: string, operacion: OperacionRcv, tipoDocCodigo: number, empresaRut?: string): Promise<DetalleAsyncRcv> {
    this.validarPeriodo(periodo);
    const { rut, dv } = this.rutEmpresa(empresaRut);
    const solicitudes = await this.estado(periodo, operacion, tipoDocCodigo, empresaRut);
    if (solicitudes.length === 0) {
      throw new RecursoNoEncontrado(
        `No hay una solicitud asíncrona del RCV para ${operacion} ${tipoDocCodigo} en ${periodo}. `
        + 'Creá una con /v1/rcv/async/solicitar antes de pedir el detalle.');
    }
    const lista = solicitudes.find(s => s.terminada && s.blobId);
    if (!lista) {
      const est = solicitudes[0];
      throw new LimitacionConocida(
        `La solicitud asíncrona del RCV está en estado "${est.estado}", todavía no terminada. `
        + 'Reintentá el detalle en unos segundos.');
    }

    const usuario = this.session.identidad().rut;
    const url = `${BASE}/obtenerArchivoBLOB/${lista.blobId}/${usuario}/${rut}/${lista.solicitudId}`;
    const { contenido } = await this.http.getBinario(url);
    // El archivo es gzip (magic 1f 8b). Si no lo es, NO es "sin documentos": es
    // un error (HTML de sesión, respuesta vacía) y así se dice.
    if (contenido.length < 2 || contenido[0] !== 0x1f || contenido[1] !== 0x8b) {
      throw new Error(
        `El SII no devolvió un .csv.gz para la solicitud ${lista.solicitudId} `
        + `(${contenido.length} bytes, primer byte 0x${(contenido[0] ?? 0).toString(16)}). La sesión pudo expirar.`);
    }
    const csv = zlib.gunzipSync(contenido).toString('latin1');
    const { columnas, filas } = parsearCsv(csv);

    // Control de resultado conocido: el SII declaró cuántos DOCUMENTOS tiene el
    // archivo (caNumLineas). No es la cantidad de filas —un documento con otros
    // impuestos ocupa varias—, sino los valores distintos de la primera columna
    // ("Nro"). Si no coincide, algo se truncó o se leyó de más; devolver el
    // número equivocado en silencio es el peor final.
    const columnaNro = columnas[0];
    const totalDocumentos = new Set(filas.map(f => f[columnaNro]).filter(v => v !== "")).size;
    if (totalDocumentos !== lista.registros) {
      throw new Error(
        `El detalle asíncrono del RCV trae ${totalDocumentos} documentos (por la columna "${columnaNro}") `
        + `pero el SII declaró ${lista.registros}: no se entrega un detalle que no cuadra con lo que el SII generó.`);
    }

    return { periodo: Number(periodo), operacion, tipoDocCodigo, solicitudId: lista.solicitudId, totalDocumentos, columnas, filas };
  }
}
