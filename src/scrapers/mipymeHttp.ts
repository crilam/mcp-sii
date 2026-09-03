import { SiiHttpClient } from '../http';
import { Empresa, SessionManager } from '../session';
import { rutEsValido } from '../rut';
import { EscrituraRechazadaPorSii, LimitacionConocida } from '../erroresConsulta';
import { marcarSeguro } from '../idempotenciaEscritura';
import { esperar, pausaConfigurada } from '../ritmoSii';

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function aIsoUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// El cuerpo del RUT, sin puntos ni dígito verificador, que es como lo quiere el
// formulario de descarga. Acepta las dos formas que manda la gente —"77777777-7"
// y "77777777"— porque mandar el DV pegado no da error: da CERO resultados, y un
// respaldo vacío se lee igual que "no hubo documentos en el período".
function soloCuerpoRut(rut: string): string {
  return rut.trim().replace(/\./g, '').split('-')[0];
}

// El round-trip a ISO es lo que descarta un 31 de febrero: el Date lo normaliza
// al 3 de marzo y deja de coincidir con lo pedido.
function esFechaDelCalendario(fecha: string): boolean {
  const d = new Date(`${fecha}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === fecha;
}

// Portal mipyme (Sistema de Facturación Gratuito) por HTTP directo, sin
// navegador. Contratos relevados en vivo el 2026-08-03:
// docs/superpowers/specs/2026-08-03-mipyme-http-contratos.md
//
// Son CGI legacy, no aplicaciones SDI: responden HTML en ISO-8859-1 y hay que
// parsearlo. El mismo terreno que las boletas de honorarios.
const CGI_BASE = 'https://www1.sii.cl/cgi-bin/Portal001';
const SEL_EMPRESA_URL = `${CGI_BASE}/mipeSelEmpresa.cgi`;
const HISTORIAL_URL = `${CGI_BASE}/mipeAdminDocsEmi.cgi`;
// El historial del lado RECIBIDO. El nombre no se adivinó: el menú del portal
// lleva a `mipeLaunchPage.cgi?OPCION=1&TIPO=4`, que asigna por JavaScript el CGI
// de verdad. Es `...Rcp.cgi` y no `...Rec.cgi`, que era la corazonada obvia — la
// misma clase de corazonada que falló cuatro de cuatro veces relevando el RCV.
const HISTORIAL_RECIBIDOS_URL = `${CGI_BASE}/mipeAdminDocsRcp.cgi`;

// PDF de UN documento. Sale de la página de gestión del documento
// (`mipeGesDocRcp.cgi`), donde el portal lo ofrece como "VISUALIZACIÓN DOCUMENTO
// (pdf)". Toma el CODIGO del listado y nada más.
//
// NO se usa `mipeDownLoad.cgi` ni `mipeImprimeDocAdm.cgi`, que es a donde apunta
// el listado: esos bajan el LOTE entero según los filtros de la pantalla, no un
// documento, y los dispara un reCAPTCHA (`llamaRecaptchaConCallback`), o sea que
// no son un camino que un servicio pueda recorrer solo.
const PDF_DOCUMENTO_URL = `${CGI_BASE}/mipeShowPdf.cgi`;

// Respaldo XML de los DTE ("Respaldo de DTE y/o IECV" → "Descargar información
// electrónica" en el menú del portal). Relevado en vivo el 2026-09-02.
//
// Son TRES CGI y el orden importa: `download.cgi` sólo entrega el XML si antes
// se pasó por `auth.cgi` —que abre el contexto de descarga— y por
// `lista_documentos.cgi`, que fija la búsqueda.
//
// El menú NO enlaza `auth.cgi` sino `/Portal001/auth.html`, una página cuyo
// único contenido útil es un `window.location.href` a `auth.cgi`. Quedarse en el
// `.html` es lo que hizo que un relevamiento anterior concluyera que el XML no
// era alcanzable: la página que se leía no es la que tiene el formulario.
//
// El reCAPTCHA de la pantalla NO bloquea este camino. El propio JavaScript
// agrega `recaptcha-response` sólo `if (token && token.value.length>0)`, y
// `download.cgi` entrega el XML sin token — verificado contra el SII real. Es
// distinto de `mipeDownLoad.cgi` (el del listado), que sí lo exige.
const AUTH_DESCARGA_URL = `${CGI_BASE}/auth.cgi`;
const LISTA_DOCUMENTOS_URL = `${CGI_BASE}/lista_documentos.cgi`;
const DOWNLOAD_URL = `${CGI_BASE}/download.cgi`;

// Tope de documentos por descarga que impone el SII. No es del JavaScript de la
// pantalla —que también lo mira—: el servidor responde una página de error
// cuando el rango trae más, así que hay que trocear sí o sí.
const TOPE_DOCUMENTOS_SII = 20;

// Tope de tramos de un respaldo. Existe porque el troceo hace una llamada al SII
// por tramo DENTRO de una sola request del tenant: sin techo, un rango ancho
// sobre una empresa con mucho volumen se convierte en un barrido, que es
// justamente el patrón que hace que el SII bloquee el portal (ver ritmoSii.ts).
const MAX_TRAMOS_POR_DEFECTO = 10;

// Techo duro, aunque el caller pida más. Es el mismo número que expone el schema
// REST, repetido acá porque el schema no cubre a quien llame al scraper directo.
//
// RIESGO ASUMIDO: el presupuesto es POR REQUEST, no por cliente ni por ventana.
// Nada impide repetir requests de 48 tramos sobre el mismo RUT; el lock de
// empresa los serializa —no corren en paralelo— pero no acota el volumen
// agregado contra el portal. Si alguna vez el SII corta por esta ruta, el
// arreglo es un presupuesto por ventana, no bajar este número.
const MAX_TRAMOS_ABSOLUTO = 48;

// Los BORRADORES no viven en el portal viejo. El menú los publica con una
// función JavaScript (`printLinkAdmBorradores`, definida en `valores.js`) que
// arma un enlace a otra aplicación, en otro host y con otra tecnología: una SPA
// con API SDI, igual que el RCV. Los nombres salieron de su bundle
// (`app.full.min.js`), que es la única forma que funcionó de relevar el RCV
// después de que cuatro nombres "obvios" fallaran.
const BORRADORES_BASE = 'https://www4.sii.cl/mipymeinternetui/services/data/borradorService';
const BORRADORES_NAMESPACE = 'cl.sii.sdi.lob.diii.mipyme.data.impl.BorradorApplicationService';
// El listado NO usa el sobre SDI por POST, a diferencia del RCV: el bundle lo
// declara con `createGetOperation` y el servidor lo confirma — un POST devuelve
// 500 con "No resource method found for POST" (medido). Es un GET simple.
const BORRADORES_LISTADO_URL = `${BORRADORES_BASE}/listaBorrador`;

// Emisión. Relevado en vivo el 2026-08-11; reemplaza a `mipeDocAlta.cgi`, que
// nunca existió (404) y que era a donde apuntaba el camino de navegador.
//
//   GET  mipeGenFacEx.cgi?PTDC_CODIGO=<tipo>   formulario
//   POST mipeDisplayPreView.cgi                previsualización — NO emite
//   POST mipeGenXMLFirma.cgi                   FIRMA — acá se emite
//
// El portal llega al formulario por `mipeLaunchPage.cgi?OPCION=<tipo>&TIPO=4`,
// que sólo hace un `location.replace` a `mipeGenFacEx.cgi`: por HTTP se va
// directo y ese salto se ahorra.
const FORM_EMISION_URL = `${CGI_BASE}/mipeGenFacEx.cgi`;
const PREVIEW_URL = `${CGI_BASE}/mipeDisplayPreView.cgi`;
// Guardar un BORRADOR: el botón "Guardar Borrador" del form de emisión cambia el
// action a este CGI y pone ES_BORR='TRUE'. Es el MISMO form (mismos campos que
// arma `armarCamposEmision`), no un endpoint aparte. Relevado del form real
// (relevarMipymeBorrador.ts). A diferencia de emitir, un borrador NO se firma:
// no es un DTE tributario, es reversible (se puede editar o descartar).
const GRABA_BORRADOR_URL = `${CGI_BASE}/mipeGrabaBorrador.cgi`;
// Mensaje de la página de éxito de mipeGrabaBorrador.cgi, relevado de un grabado
// real: "Su documento borrador ha sido grabado/actualizado con éxito". Se afloja
// para tolerar variantes que el portal podría usar según nuevo vs editar
// ("grabado con éxito", "actualizado con éxito") y la entidad HTML de la é: un
// grabado exitoso leído como rechazo haría reintentar y duplicar el borrador.
const GRABADO_OK = /borrador\s+ha\s+sido\s+(?:grabado\/actualizado|grabado|actualizado)[^.<]{0,20}con\s+(?:&eacute;|é|e)xito/i;
// OJO con el nombre: `mipeGenXMLFirma.cgi` NO emite. Arma el XML del DTE, le
// propone un folio y devuelve la página que pide la firma. Faltan tres pasos
// más, y el último es el que emite:
//
//   GET  getCertDigital.cgi?rut=&dv=   ¿hay certificado centralizado? → certId
//   POST postFirmaDigital.cgi          el SII firma el XML con ese certificado
//   POST mipeSendXML.cgi               EMITE
//
// Que el SII firme del lado servidor es lo que hace posible emitir por HTTP: en
// la otra modalidad ("certificado local") la firma la hace un plug-in del
// navegador con el certificado instalado en la máquina, y eso no se puede
// replicar desde acá.
const FIRMA_URL = `${CGI_BASE}/mipeGenXMLFirma.cgi`;
const CERT_DIGITAL_URL = `${CGI_BASE}/getCertDigital.cgi`;
const FIRMA_DIGITAL_URL = `${CGI_BASE}/postFirmaDigital.cgi`;
// ATENCIÓN: este POST EMITE un documento tributario real e irreversible. Es el
// único lugar del proyecto que lo hace. No agregarle llamadores sin una
// confirmación explícita del usuario.
const SEND_XML_URL = `${CGI_BASE}/mipeSendXML.cgi`;

// Los tres parámetros que identifican qué nodo del XML se firma. Salen del
// `signXmlCompatible` del plugin del portal (pluginsii-1.2.js) para el caso
// OpcionDTE, que es el de factura, exenta y nota de crédito. Las liquidaciones
// (43) y las exportaciones (110-112) usan otros nodos, y es una razón más para
// no emitirlas sin relevarlas.
const NODO_FIRMA_DTE = { nodo: 'dte:DTE', nodoId: 'dte:Documento', nameSpace: 'http://www.sii.cl/SiiDte' };

const TASA_IVA = 0.19;

// Tipos cuyo formulario se relevó en vivo. El resto de los que ofrece el portal
// (52 guía, 46 factura de compra, 43 liquidación, 110 exportación) usa el mismo
// CGI pero con campos propios que NO se relevaron: emitirlos sería adivinar los
// parámetros de un acto tributario, que es exactamente lo que esta migración
// vino a dejar de hacer.
const TIPOS_SOPORTADOS = [33, 34, 61] as const;

const TIPO_DTE_NOMBRES: Record<string, number> = {
  'Factura Electronica': 33,
  'Factura No afecta o exenta': 34,
  'Factura Exenta Electronica': 34,
  'Nota de Credito': 61,
  'Nota de Credito Electronica': 61,
  'Nota de Debito': 56,
  'Nota de Debito Electronica': 56,
  'Guia de Despacho': 52,
  // El portal escribe el nombre CON "Electronica" en el historial de recibidos
  // ("Guia de Despacho Electronica"). Sin esta variante el tipo salía en 0 —
  // medido en vivo, 3 de 100 documentos— y un consumidor que filtre por tipo los
  // pierde sin enterarse. Las demás familias ya tenían su par por la misma razón.
  'Guia de Despacho Electronica': 52,
  'Factura de Compra': 46,
  'Factura de Compra Electronica': 46,
};

export interface DteEmitidoMipyme {
  tipoDte: number;
  tipoDteNombre: string;
  folio: number;
  fecha: string;
  receptorRut: string;
  receptorNombre: string;
  monto: number;
  estado: string;
  // Identificador interno del documento que trae el link de cada fila. NO es el
  // folio y no se puede derivar de los datos de la fila: es el único parámetro
  // con el que el CGI de detalle (mipeGesDocEmi.cgi) acepta ser consultado, así
  // que se propaga en vez de descartarse.
  codigo: string;
}

export interface DteRecibidoMipyme {
  tipoDte: number;
  tipoDteNombre: string;
  folio: number;
  fecha: string;
  emisorRut: string;
  emisorNombre: string;
  monto: number;
  estado: string;
  codigo: string;
}

// El lado del respaldo: `RCP` son los documentos RECIBIDOS y `ENV` los emitidos.
// Son los valores del `<select name="ORIGEN">` del portal, no una convención de
// este repo.
export type OrigenRespaldo = 'RCP' | 'ENV';

export interface FiltrosRespaldoXml {
  empresaRut?: string;
  origen: OrigenRespaldo;
  fechaDesde: string;
  fechaHasta: string;
  tipoDte?: number;
  // La CONTRAPARTE, no "el receptor": con `origen: 'RCP'` es el emisor del
  // documento y con `ENV` es el receptor. El portal usa el mismo campo
  // (`RUT_RECP`) para los dos lados en esta pantalla —a diferencia del listado,
  // que sí los separa en `RUT_EMI`/`RUT_RECP`—, así que el nombre neutro es el
  // que no miente en ninguno de los dos casos.
  contraparteRut?: string;
  razonSocial?: string;
  folioDesde?: number;
  folioHasta?: number;
  maxTramos?: number;
}

// Un tramo es UNA descarga del SII: un `SetDTE` completo y válido por sí solo.
// Los tramos NO se concatenan en un XML único a propósito — dos `SetDTE` pegados
// no son un documento XML bien formado, y unificarlos obligaría a reescribir el
// contenido firmado por el emisor.
export interface TramoRespaldoXml {
  fechaDesde: string;
  fechaHasta: string;
  documentos: number;
  xml: string;
}

export interface RespaldoXmlResult {
  empresaRut: string;
  origen: OrigenRespaldo;
  fechaDesde: string;
  fechaHasta: string;
  documentos: number;
  tramos: TramoRespaldoXml[];
}

export interface FiltrosDteRecibidos {
  empresaRut?: string;
  tipoDte?: number;
  fechaDesde?: string;
  fechaHasta?: string;
  // El filtro por contraparte es por EMISOR, no por receptor: del lado recibido
  // la contraparte es quien emitió el documento.
  emisorRut?: string;
  folio?: number;
  pagina?: number;
}

export interface DteRecibidosResult {
  documentos: DteRecibidoMipyme[];
  pagina: number;
  totalPaginas: number | null;
  empresaRut: string;
}

// Un borrador tal como lo devuelve la aplicación de borradores. Los nombres de
// los campos son los del SII —mayúsculas y guiones bajos incluidos— y no se
// renombran: son un contrato ajeno, y traducirlos obligaría a mantener un
// diccionario que se desactualiza en silencio cuando el SII agrega un campo.
export interface BorradorMipyme {
  codigo: string;
  tipoDte: number | null;
  campos: Record<string, unknown>;
}

export interface FiltrosDteEmitidos {
  // Opcional a propósito: si la persona opera UNA sola empresa en este portal,
  // se resuelve sola. Con varias, se exige elegir — devolver la primera sería
  // consultar un contribuyente distinto al que el llamador tenía en mente.
  empresaRut?: string;
  tipoDte?: number;
  fechaDesde?: string;
  fechaHasta?: string;
  receptorRut?: string;
  folio?: number;
  pagina?: number;
}

export interface DteEmitidosResult {
  documentos: DteEmitidoMipyme[];
  // Qué página se pidió y cuántas hay. Sin las dos, una página inexistente
  // devuelve una lista vacía indistinguible de "esta empresa no emitió nada".
  // `totalPaginas` sale del "Página 1 de 3" del propio HTML; es null si esa
  // leyenda no está, y entonces no se puede afirmar cuántas hay.
  pagina: number;
  totalPaginas: number | null;
  empresaRut: string;
}

export interface LineaDteMipyme {
  nombre: string;
  cantidad: number;
  precioUnitario: number;
  unidad?: string;
}

export interface TotalesDte {
  subtotales: number[];
  neto: number;
  iva: number;
  total: number;
}

export interface EmisorFormulario {
  razonSocial: string;
  giro: string;
  acteco: string;
  direccion: string;
  comuna: string;
  ciudad: string;
  codigoSucursal: string;
  email: string;
  fechaEmision: string;
}

// Las entidades del portal llegan en las dos formas: nombradas (&aacute;) y
// NUMÉRICAS (&#205; por la Í, &#64; por la arroba). Las numéricas aparecen
// justamente en la razón social y el correo del emisor, que el POST de emisión
// reenvía: no decodificarlas emite el DTE con "&#205;" literal en el nombre del
// contribuyente.
//
// `&amp;` va ÚLTIMO por la misma razón que en `decodificar`: resolverlo primero
// convertiría un `&amp;#205;` escrito así por el SII en `&#205;`, y la pasada
// siguiente lo decodificaría dos veces.
export function decodificarEntidades(texto: string): string {
  return texto
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
    .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// Todos los campos de un <form> por nombre. Se usa sobre la PREVISUALIZACIÓN,
// cuyos 243 hidden son el documento completo ya normalizado por el SII: firmar
// es reenviarlos verbatim, así que este parseo es lo que separa "firmo lo que
// vi" de "firmo lo que creo que armé".
//
// OJO: NO sirve para el formulario de emisión. Ahí el HTML crudo trae 47
// <input> contra 67 en el DOM porque los <select> y varios campos los dibuja
// JavaScript; para ese lado está `parseEmisorDesdeFormulario`.
export function parseCamposFormulario(html: string, nombreForm: string): Record<string, string> {
  const apertura = new RegExp(`<form[^>]*name=["']${nombreForm}["'][^>]*>`, 'i').exec(html);
  if (!apertura) {
    throw new Error(
      `El portal mipyme no devolvió el formulario "${nombreForm}". La sesión pudo caer o el ` +
      `portal pudo cambiar; no se puede continuar con un documento a medias.`
    );
  }
  const desde = apertura.index + apertura[0].length;
  const cierre = html.indexOf('</form>', desde);
  const bloque = html.slice(desde, cierre === -1 ? undefined : cierre);

  const campos: Record<string, string> = {};
  for (const m of bloque.matchAll(/<input\b([^>]*)>/gi)) {
    const atributos = m[1];
    const nombre = /\bname\s*=\s*["']([^"']+)["']/i.exec(atributos)?.[1];
    if (!nombre) continue;
    const tipo = (/\btype\s*=\s*["']([^"']+)["']/i.exec(atributos)?.[1] ?? 'text').toLowerCase();
    // Los botones no son datos del documento y el navegador no los manda (sólo
    // viajaría el que se apretó, y acá el submit lo hace JavaScript).
    if (tipo === 'button' || tipo === 'submit' || tipo === 'reset') continue;
    // Un checkbox sin `checked` tampoco viaja. Mandarlo igual activaría bloques
    // del documento —referencias, otros impuestos— que el usuario no pidió.
    if ((tipo === 'checkbox' || tipo === 'radio') && !/\bchecked\b/i.test(atributos)) continue;
    campos[nombre] = decodificarEntidades(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(atributos)?.[1] ?? '');
  }

  // Los <textarea> también viajan, y en la página de firma son los que importan:
  // `txtPlainText` trae el XML completo del DTE y `txtSignText` es donde va la
  // firma. Un parser que sólo mirara <input> mandaría el documento sin su XML.
  //
  // El contenido NO se decodifica: es XML, y sus `&lt;`/`&amp;` son parte del
  // dato que el SII va a firmar. Decodificarlos rompería la firma.
  for (const m of bloque.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const nombre = /\bname\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1];
    if (nombre) campos[nombre] = m[2];
  }

  return campos;
}

// Datos del emisor que el formulario de emisión necesita de vuelta en el POST.
// Vienen de dos lugares y hay que ir a buscarlos a los dos:
//
//   - Del HTML: razón social, giro, acteco, correo, fecha.
//   - De un arreglo JavaScript embebido (`emisorDir`): dirección, comuna,
//     ciudad y el CÓDIGO DE SUCURSAL. El <input> EFXP_CDG_SII_SUCUR viene con
//     value="" y sólo lo llena el JS del portal al cargar la página, así que
//     leerlo del input manda la sucursal vacía en un documento tributario.
//
// El arreglo se lee con una regex sobre su literal, sin ejecutar JavaScript.
export function parseEmisorDesdeFormulario(html: string): EmisorFormulario {
  const valorDe = (nombre: string): string => {
    const patron = new RegExp(`<input\\b[^>]*\\bname\\s*=\\s*["']${nombre}["'][^>]*>`, 'i');
    const etiqueta = patron.exec(html)?.[0] ?? '';
    return decodificarEntidades(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(etiqueta)?.[1] ?? '');
  };

  // Los dos arreglos traen una fila por opción del <select> que dibuja el JS, y
  // la PRIMERA es la que queda seleccionada al cargar la página. Se toma esa:
  // es el default que vería quien abre el formulario en el navegador. Una
  // empresa con varias sucursales o varios actecos tiene más filas, y elegir
  // otra es una decisión del emisor que hoy no se expone.
  //
  //   emisorDir    = [["DIRECCION","COMUNA","CIUDAD","CODIGO_SUCURSAL"," "], ...]
  //   emisorActEco = [["702000","ACTIVIDADES DE ..."], ...]
  const primeraFila = (nombre: string): string[] => {
    const fila = new RegExp(`var\\s+${nombre}\\s*=\\s*\\[\\s*\\[([^\\]]*)\\]`, 'i').exec(html)?.[1] ?? '';
    return [...fila.matchAll(/"([^"]*)"/g)].map(m => decodificarEntidades(m[1]));
  };
  const celdas = primeraFila('emisorDir');

  return {
    razonSocial: valorDe('EFXP_RZN_SOC'),
    giro: valorDe('EFXP_GIRO_EMIS'),
    // Igual que la sucursal: el <input> EFXP_ACTECO viene con value="" y el
    // código real sólo está en el arreglo. Un DTE sin actividad económica del
    // emisor no pasa la validación del portal.
    acteco: primeraFila('emisorActEco')[0] ?? '',
    direccion: celdas[0] ?? '',
    comuna: celdas[1] ?? '',
    // Llega vacía aunque el portal la exige. No se rellena acá: inventar la
    // ciudad del emisor en un DTE es peor que fallar pidiéndola.
    ciudad: celdas[2] ?? '',
    codigoSucursal: celdas[3] ?? '',
    email: valorDe('EFXP_EMAIL_EMISOR'),
    // Igual que la sucursal y el acteco: el <input type="date"> viene con
    // value="" y la fecha del portal está sólo en el arreglo `arrFecha`, que es
    // además la que el propio SII considera "hoy". Mandarla vacía hace que el
    // CGI rechace con "Debe ingresar el campo : Fecha emision" — un error que
    // llega escondido dentro de un alert() y es fácil leer como "falló el POST".
    //
    // No se usa el reloj local: la fecha válida es la del servidor del SII, y
    // el portal valida que no sea anterior a la autorización del documento.
    fechaEmision: fechaDesdeArreglo(html),
  };
}

// arrFecha = ["2026","08","11"] → "2026-08-11", el formato que espera el CGI.
function fechaDesdeArreglo(html: string): string {
  const fila = /var\s+arrFecha\s*=\s*\[([^\]]*)\]/i.exec(html)?.[1] ?? '';
  const partes = [...fila.matchAll(/"([^"]*)"/g)].map(m => m[1]);
  return partes.length === 3 ? partes.join('-') : '';
}

// La aritmética la hace el JavaScript del portal y los resultados VIAJAN en el
// POST: el CGI los recibe tal cual, no los recalcula. Hay que reproducirla, y
// el redondeo importa — `Math.round` sobre el neto por la tasa, medido contra
// el portal el 2026-08-11:
//
//   neto  1 → IVA 0     neto  3 → IVA 1     neto 10 → IVA 2
//
// De ahí sale que el neto mínimo emisible en una factura afecta sea 3: con 1 o
// 2 el IVA da 0 y el portal rechaza con "Valor IVA debe ser mayor a 0".
export function calcularTotales(lineas: LineaDteMipyme[]): TotalesDte {
  const subtotales = lineas.map(l => l.cantidad * l.precioUnitario);
  const neto = subtotales.reduce((a, b) => a + b, 0);
  const iva = Math.round(neto * TASA_IVA);
  return { subtotales, neto, iva, total: neto + iva };
}

export interface ReceptorDte {
  // El portal pide RUT y DV por separado, y valida el DV con módulo 11.
  rut: string;
  dv: string;
  razonSocial: string;
  giro: string;
  direccion: string;
  comuna: string;
  ciudad: string;
}

export interface ReferenciaDteMipyme {
  tipoDoc: number;
  folio: number;
  // AAAA-MM-DD, entre 2002-08-01 y 2050-12-31 según valida el portal.
  fecha: string;
  razon?: string;
  // 1 anula, 2 corrige texto, 3 corrige montos. Obligatorio en nota de crédito.
  codigo?: 1 | 2 | 3;
}

export interface EmitirDteParams {
  empresaRut?: string;
  tipoDte: number;
  receptor: ReceptorDte;
  lineas: LineaDteMipyme[];
  // 1 Contado, 2 Crédito, 3 Sin Costo. El portal trae Crédito por defecto.
  formaPago?: 1 | 2 | 3;
  // El portal exige la ciudad del emisor y no la trae cargada. Si no viene, se
  // usa la comuna: es lo que hace cualquiera llenando el formulario a mano, y
  // es preferible a fallar por un campo que el propio SII dejó vacío.
  ciudadEmisor?: string;
  fechaEmision?: string;
  referencias?: ReferenciaDteMipyme[];
}

export interface ResumenDte {
  tipoDte: number;
  emisorRut: string;
  emisorRazonSocial: string;
  receptorRut: string;
  receptorRazonSocial: string;
  fechaEmision: string;
  neto: number;
  iva: number;
  total: number;
}

export interface PrevisualizacionDte {
  emitido: false;
  resumen: ResumenDte;
  // Los 243 hidden del form PreViewDTE. Es el documento tal como el SII lo
  // normalizó; firmarlo es reenviarlos sin tocar nada.
  campos: Record<string, string>;
}

export interface DteEmitido {
  emitido: true;
  folio: number;
  resumen: ResumenDte;
}

export interface BorradorGuardado {
  // false = simulación (confirmar:false), no se guardó nada.
  guardado: boolean;
  resumen: ResumenDte;
  // EHDR_CODIGO del borrador. Al EDITAR es el id que se pasó; al crear uno NUEVO
  // es `null`, porque la respuesta de grabado del SII no lo devuelve — hay que
  // buscarlo con list-borradores. La simulación NO verifica que un borrador a
  // editar exista: sólo valida el documento y devuelve el id de entrada.
  borradorId: string | null;
}

export class MipymeHttpScraper {
  constructor(
    private http: SiiHttpClient,
    private session: SessionManager
  ) {}

  // Las consultas por HTTP necesitan el cookie jar. Se verifica ANTES de tocar
  // la red para no abrir una sesión en el SII que no se va a poder usar y que
  // igual cuenta para el límite de sesiones simultáneas.
  //
  // Este comentario decía "que sólo produce la autenticación con certificado".
  // Dejó de ser cierto en el PR #55: las DOS estrategias producen el jar, y la
  // lectura de mipyme anda con clave tributaria (ver
  // SessionManager.assertPuedeEntregarCookieJar, que ya no rechaza nada). El
  // certificado sigue siendo obligatorio sólo para `emitirDte`, porque firmar lo
  // necesita de verdad.
  async listEmpresas(): Promise<Empresa[]> {
    this.session.assertPuedeEntregarCookieJar();
    return this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
  }

  // La empresa activa del portal mipyme es estado del lado del SERVIDOR: el POST
  // de selección no escribe ninguna cookie que podamos inspeccionar (medido
  // comparando el cookie jar antes y después). O sea que dos consultas con
  // empresas distintas se pisan igual que con el navegador —A selecciona, B
  // selecciona, A lee, y A devuelve datos de B como si fueran propios—, así que
  // el ciclo completo va serializado. El candado no es herencia del navegador.
  async listDteEmitidos(filtros: FiltrosDteEmitidos): Promise<DteEmitidosResult> {
    const pagina = filtros.pagina ?? 1;
    if (!Number.isInteger(pagina) || pagina < 1) {
      throw new Error(`pagina debe ser un entero mayor o igual a 1; se recibió ${filtros.pagina}`);
    }
    this.session.assertPuedeEntregarCookieJar();

    return this.session.conEmpresaExclusiva(async () => {
      const empresas = this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
      const empresaRut = this.resolverEmpresa(empresas, filtros.empresaRut);

      await this.http.postForm(SEL_EMPRESA_URL, { RUT_EMP: empresaRut });

      const html = await this.http.get(HISTORIAL_URL, this.params(filtros, pagina));
      this.assertEmpresaSeleccionada(html);

      return {
        documentos: this.parseHistorial(html),
        pagina,
        totalPaginas: this.parseTotalPaginas(html),
        empresaRut,
      };
    });
  }

  // El lado RECIBIDO del historial. Mismo ciclo que emitidos y por las mismas
  // razones: la empresa activa es estado del servidor, así que seleccionar y
  // consultar van juntos en la sección crítica o dos consultas concurrentes se
  // pisan y una devuelve los documentos de la otra.
  async listDteRecibidos(filtros: FiltrosDteRecibidos): Promise<DteRecibidosResult> {
    const pagina = filtros.pagina ?? 1;
    if (!Number.isInteger(pagina) || pagina < 1) {
      throw new Error(`pagina debe ser un entero mayor o igual a 1; se recibió ${filtros.pagina}`);
    }
    this.session.assertPuedeEntregarCookieJar();

    return this.session.conEmpresaExclusiva(async () => {
      const empresas = this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
      const empresaRut = this.resolverEmpresa(empresas, filtros.empresaRut);

      await this.http.postForm(SEL_EMPRESA_URL, { RUT_EMP: empresaRut });

      const html = await this.http.get(
        HISTORIAL_RECIBIDOS_URL, this.paramsRecibidos(filtros, pagina));
      this.assertEmpresaSeleccionada(html);

      return {
        documentos: this.parseHistorialRecibidos(html),
        pagina,
        totalPaginas: this.parseTotalPaginas(html),
        empresaRut,
      };
    });
  }

  /**
   * PDF de un documento del portal, emitido o recibido.
   *
   * Se identifica por el `codigo` que publica el listado y NO por el folio: el
   * folio se repite entre emisores y entre tipos de documento, así que no
   * identifica nada por sí solo. Es el mismo criterio que el PDF de BHE, que va
   * por código de barras y no por folio.
   */
  async dtePdf(codigo: string, empresaRut?: string): Promise<Buffer> {
    if (!/^\d+$/.test(codigo.trim())) {
      throw new Error(
        `El codigo del documento tiene que ser el que devuelve el listado del portal `
        + `(sólo dígitos); se recibió "${codigo.slice(0, 40)}".`);
    }
    this.session.assertPuedeEntregarCookieJar();

    return this.session.conEmpresaExclusiva(async () => {
      const empresas = this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
      const resuelta = this.resolverEmpresa(empresas, empresaRut);
      // Sin la selección, el CGI responde "Su requerimiento no ha sido bien
      // recepcionado" — un error genérico que manda a revisar el navegador
      // cuando lo que falta es el contexto de empresa.
      await this.http.postForm(SEL_EMPRESA_URL, { RUT_EMP: resuelta });

      const { contenido, contentType } = await this.http.getBinario(
        PDF_DOCUMENTO_URL, { CODIGO: codigo.trim() });

      // El CGI responde 200 con HTML cuando algo falla, así que el status no
      // distingue nada: lo que separa un PDF de un error es el Content-Type. Sin
      // este chequeo el fallo viajaría como un "PDF" que ningún lector abre.
      if (!/application\/pdf/i.test(contentType)) {
        const cuerpo = contenido.subarray(0, 4096).toString('latin1');
        const codigoSii = cuerpo.match(/CODIGO:\s*([\d.\-]+)/)?.[1];
        throw new Error(
          `El portal mipyme no devolvió un PDF para el documento ${codigo.slice(0, 40)} `
          + `(Content-Type: ${contentType || 'sin declarar'})`
          + `${codigoSii ? `, código del SII ${codigoSii}` : ''}.`);
      }
      return contenido;
    });
  }

  /**
   * Respaldo XML de los DTE de un rango de fechas, tal como lo entrega el
   * portal: el `SetDTE` firmado, sin reescribir.
   *
   * Es la fuente buena para procesar documentos recibidos. El PDF de
   * `dtePdf` sirve para MIRAR un documento; el XML trae el detalle línea a línea
   * (`NmbItem`, `QtyItem`, `PrcItem`, `MontoItem`) y el giro del emisor
   * (`Acteco`, `GiroEmis`) en campos, sin parsear una maqueta de impresión.
   *
   * El SII no entrega más de 20 documentos por descarga, así que un rango que
   * los exceda se parte en dos por la mitad y cada mitad se pide aparte
   * (recursivamente). Cada tramo devuelto es un `SetDTE` independiente.
   */
  async respaldoXml(filtros: FiltrosRespaldoXml): Promise<RespaldoXmlResult> {
    const { fechaDesde, fechaHasta } = filtros;
    if (!FECHA_ISO.test(fechaDesde) || !FECHA_ISO.test(fechaHasta)) {
      throw new Error(
        `Las fechas del respaldo van en formato YYYY-MM-DD; se recibió `
        + `"${fechaDesde}" y "${fechaHasta}".`);
    }
    // El formato no basta: `2026-02-31` lo cumple y no existe. El schema REST ya
    // lo rechaza, y el chequeo se repite acá porque es una invariante de ESTE
    // método —hace aritmética con las fechas— y no de quien lo llame: sin él,
    // una fecha imposible sale como RangeError desde `toISOString`, recién al
    // trocear y sin decir cuál era el problema.
    for (const fecha of [fechaDesde, fechaHasta]) {
      if (!esFechaDelCalendario(fecha)) {
        throw new Error(`${fecha} no es una fecha del calendario.`);
      }
    }
    if (fechaDesde > fechaHasta) {
      throw new Error(
        `El rango del respaldo está invertido: ${fechaDesde} es posterior a ${fechaHasta}.`);
    }
    const maxTramos = filtros.maxTramos ?? MAX_TRAMOS_POR_DEFECTO;
    // El techo se valida ACÁ y no sólo en el schema REST: el schema protege a la
    // ruta, pero este método es público y `core.respaldoXml` lo llama directo.
    // Un caller interno con maxTramos: 500 convertiría una request en el barrido
    // que ritmoSii.ts documenta como causa de bloqueo del portal, sin pasar por
    // ninguna validación. El límite es del scraper porque el riesgo es suyo.
    if (!Number.isInteger(maxTramos) || maxTramos < 1 || maxTramos > MAX_TRAMOS_ABSOLUTO) {
      throw new Error(
        `maxTramos debe ser un entero entre 1 y ${MAX_TRAMOS_ABSOLUTO}; se recibió ${filtros.maxTramos}`);
    }
    this.session.assertPuedeEntregarCookieJar();

    return this.session.conEmpresaExclusiva(async () => {
      const empresas = this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
      const empresaRut = this.resolverEmpresa(empresas, filtros.empresaRut);
      await this.http.postForm(SEL_EMPRESA_URL, { RUT_EMP: empresaRut });

      // `auth.cgi` abre el contexto de descarga. Va DESPUÉS de seleccionar la
      // empresa: la empresa activa es estado del servidor, y este CGI se apoya
      // en ella.
      await this.http.get(AUTH_DESCARGA_URL);

      const [rut, dv] = this.partirRut(empresaRut);
      const tramos: TramoRespaldoXml[] = [];
      await this.acumularTramos(
        { rut, dv, filtros, empresaRut, descargas: 0 }, fechaDesde, fechaHasta, tramos, maxTramos);

      return {
        empresaRut,
        origen: filtros.origen,
        fechaDesde,
        fechaHasta,
        documentos: tramos.reduce((n, t) => n + t.documentos, 0),
        tramos,
      };
    });
  }

  // El troceo: pide el rango y, si el SII contesta que son más de 20, lo parte
  // en dos y baja cada mitad. Se hace por BISECCIÓN y no estimando desde el
  // listado porque el conteo del listado y el de la descarga no tienen por qué
  // coincidir —filtran distinto—, y porque así el corte lo decide el SII, que es
  // el único que sabe cuántos documentos hay.
  private async acumularTramos(
    ctx: { rut: string; dv: string; filtros: FiltrosRespaldoXml; empresaRut: string; descargas: number },
    desde: string,
    hasta: string,
    tramos: TramoRespaldoXml[],
    maxTramos: number
  ): Promise<void> {
    // El tope cuenta DESCARGAS, no tramos logrados. Contar sólo los tramos que
    // salieron bien dejaba el caso peor sin techo: si cada intento excede el
    // tope del SII, no se acumula ninguno y la bisección seguía bajando hasta el
    // día, gastando una llamada por nivel sin que el contador se moviera nunca.
    // `LimitacionConocida` y no `Error`: los DOS fallos del troceo —éste y el
    // del día suelto— son
    // PERMANENTES —el mismo pedido va a fallar igual— y su mensaje es la parte
    // accionable. Un Error genérico sale de la ruta como `ERROR`, que en el
    // contrato de este servicio significa "reintentá" y viaja SIN detalle: el
    // consumidor perdería la instrucción y reintentaría en loop un rango que no
    // puede funcionar, gastando hasta 24 descargas contra el SII por intento.
    // Eso es justo lo que ritmoSii.ts documenta como causa de bloqueo.
    if (ctx.descargas >= maxTramos) {
      throw new LimitacionConocida(
        `El respaldo de ${ctx.empresaRut} necesita más de ${maxTramos} tramos para respetar el `
        + `tope de ${TOPE_DOCUMENTOS_SII} documentos por descarga del SII. Pedí un rango más corto `
        + `o filtrá por tipo de documento; subir el tope convierte la consulta en un barrido, que `
        + `es lo que hace que el SII bloquee el portal. ${this.progreso(tramos, desde)}`);
    }

    // La pausa va antes de cada descarga menos la primera: son varias llamadas
    // seguidas al mismo CGI, que es la firma que el SII penaliza.
    if (ctx.descargas > 0) await esperar(pausaConfigurada());
    ctx.descargas += 1;

    const respuesta = await this.descargarTramo(ctx, desde, hasta);
    if (respuesta.excedeTope) {
      if (desde === hasta) {
        throw new LimitacionConocida(
          `El día ${desde} tiene más de ${TOPE_DOCUMENTOS_SII} documentos y el SII no entrega más `
          + `por descarga. El filtro por fecha ya no se puede afinar: pedí ese día con tipo_dte `
          + `para partirlo por tipo de documento. ${this.progreso(tramos, desde)}`);
      }
      const [primerFin, segundoInicio] = this.partirRango(desde, hasta);
      await this.acumularTramos(ctx, desde, primerFin, tramos, maxTramos);
      await this.acumularTramos(ctx, segundoInicio, hasta, tramos, maxTramos);
      return;
    }

    tramos.push({
      fechaDesde: desde,
      fechaHasta: hasta,
      // Conteo por TEXTO, no por nodos: contar de verdad obligaría a parsear el
      // XML entero, que es justamente lo que esta ruta no hace —entrega el
      // documento firmado tal cual—. Un `<DTE` dentro de un comentario o un
      // CDATA inflaría el número; en el `SetDTE` del SII no los hay. Es un dato
      // para dimensionar, no un conteo tributario: quien necesite el número
      // exacto lo saca del XML que ya tiene.
      documentos: (respuesta.xml.match(/<DTE[\s>]/g) ?? []).length,
      xml: respuesta.xml,
    });
  }

  // Qué alcanzó a bajarse antes de fallar. Va en el mensaje porque un respaldo
  // que falla a mitad de camino tira TODO lo descargado —los tramos viven en
  // memoria hasta que la operación termina bien—, y sin esto el consumidor
  // reintenta el rango entero, repitiendo llamadas al SII que ya habían salido
  // bien. Con el sub-rango que sí funcionó puede reintentar acotado.
  private progreso(tramos: TramoRespaldoXml[], corteEn: string): string {
    if (tramos.length === 0) return `No alcanzó a bajarse ningún tramo (falló en ${corteEn}).`;
    const cubierto = `${tramos[0].fechaDesde}..${tramos[tramos.length - 1].fechaHasta}`;
    const documentos = tramos.reduce((n, t) => n + t.documentos, 0);
    return (
      `Se descartan ${tramos.length} tramo(s) que sí habían salido bien `
      + `(${cubierto}, ${documentos} documentos): reintentá ese sub-rango aparte, `
      + `y aparte el resto desde ${corteEn}.`);
  }

  private async descargarTramo(
    ctx: { rut: string; dv: string; filtros: FiltrosRespaldoXml },
    desde: string,
    hasta: string
  ): Promise<{ xml: string; excedeTope: boolean }> {
    const f = ctx.filtros;
    const comunes = {
      RUT_EMP: ctx.rut,
      DV_EMP: ctx.dv,
      // El portal quiere la contraparte SIN dígito verificador, igual que
      // `RUT_EMP`/`DV_EMP` van separados. Un RUT con guión acá no filtra: el CGI
      // no encuentra coincidencias y devuelve un respaldo vacío, que se lee
      // exactamente igual que "este período no tuvo documentos".
      RUT_RECP: f.contraparteRut ? soloCuerpoRut(f.contraparteRut) : '',
      FOLIO: f.folioDesde != null ? String(f.folioDesde) : '',
      RZN_SOC: f.razonSocial ?? '',
      FEC_DESDE: desde,
      FEC_HASTA: hasta,
      TPO_DOC: f.tipoDte != null ? String(f.tipoDte) : '',
      ESTADO: '',
      ORDEN: '',
    };
    // El folio de cierre viaja sólo en la descarga: el formulario de búsqueda no
    // lo lleva. Si se pidió `folioDesde` sin `folioHasta`, se repite el mismo
    // valor para que el rango sea ese folio exacto y no "de ahí en adelante".
    const folioHasta = f.folioHasta ?? f.folioDesde;

    // `lista_documentos.cgi` fija la búsqueda del lado del servidor. Sin este
    // POST, `download.cgi` no tiene contexto y devuelve una página de error.
    await this.http.postForm(LISTA_DOCUMENTOS_URL, {
      ...comunes, TPO_ARCHIVO: 'dte', ORIGEN: f.origen, NUM_PAG: '1',
    });

    // FUERA DE ALCANCE: un tramo que supere el tope de respuesta del transporte
    // (MAX_RESPUESTA_BYTES en http.ts) falla duro y NO se bisecta — la partición
    // sólo reacciona al tope de 20 documentos del SII, que es un conteo, no un
    // tamaño. Haría falta que 20 DTE sumaran varios MiB de detalle; los tramos
    // reales medidos van por 130 KB. Si alguna vez aparece, el síntoma es un
    // error de transporte y el arreglo es bisecar también ante ese error.
    const { contenido, contentType } = await this.http.getBinario(DOWNLOAD_URL, {
      ...comunes, ORIGEN: f.origen, DOWNLOAD: 'XML',
      FOLIOHASTA: folioHasta != null ? String(folioHasta) : '',
    });

    // El XML viene declarado ISO-8859-1 y así se decodifica. Pasarlo por UTF-8
    // rompería las razones sociales con acentos, que son la mayoría, y el daño
    // es silencioso: el string sigue siendo un string.
    //
    // Se mira igual lo que DECLARA el servidor, en el Content-Type o en el
    // prólogo del propio XML: si el SII algún día sirve UTF-8, forzar latin1
    // rompería los acentos con el mismo silencio, sólo que al revés. Latin1
    // queda de default porque es lo que responde hoy, verificado.
    const prologo = contenido.subarray(0, 200).toString('latin1');
    const declarado = (
      /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
      /encoding=["']([\w-]+)["']/i.exec(prologo)?.[1] ?? ''
    ).toLowerCase();
    const texto = /^utf-?8$/.test(declarado)
      ? contenido.toString('utf-8')
      : contenido.toString('latin1');

    // El corte por volumen llega como PÁGINA, no como error HTTP: el CGI
    // responde 200 con HTML. Reconocerlo es lo que permite trocear en vez de
    // fallar.
    if (/demasiados Documentos electr/i.test(texto)) return { xml: '', excedeTope: true };

    // Este SÍ queda como Error genérico —o sea `ERROR`, "reintentá"— y no como
    // LimitacionConocida: verificado en vivo que es TRANSITORIO. El mismo rango
    // ancho respondió esta página una vez y el XML completo al reintentarlo un
    // minuto después, sin cambiar nada.
    if (!/<SetDTE/i.test(texto)) {
      const codigoSii = texto.slice(0, 4096).match(/CODIGO:\s*([\d.\-]+)/)?.[1];
      throw new Error(
        `El portal mipyme no devolvió un SetDTE para ${desde}..${hasta} `
        + `(Content-Type: ${contentType || 'sin declarar'})`
        + `${codigoSii ? `, código del SII ${codigoSii}` : ''}.`);
    }
    return { xml: texto, excedeTope: false };
  }

  // Parte [desde, hasta] en dos mitades contiguas: devuelve el fin de la primera
  // y el inicio de la segunda. Se opera en UTC a propósito — con fechas locales,
  // un cambio de horario de verano corre un día y el respaldo pierde o repite
  // documentos sin que nadie lo note.
  private partirRango(desde: string, hasta: string): [string, string] {
    const inicio = Date.parse(`${desde}T00:00:00Z`);
    const fin = Date.parse(`${hasta}T00:00:00Z`);
    const DIA_MS = 24 * 60 * 60 * 1000;
    // Se redondea HACIA ABAJO para que la primera mitad nunca quede vacía
    // cuando el rango son dos días.
    const medio = inicio + Math.floor((fin - inicio) / (2 * DIA_MS)) * DIA_MS;
    return [aIsoUtc(medio), aIsoUtc(medio + DIA_MS)];
  }

  private partirRut(rut: string): [string, string] {
    const [cuerpo, dv] = rut.split('-');
    if (!cuerpo || !dv) {
      throw new Error(`El RUT de la empresa tiene que venir con guión y dígito verificador; se recibió "${rut}".`);
    }
    return [cuerpo.replace(/\./g, ''), dv];
  }

  /**
   * Borradores de DTE de la empresa.
   *
   * Selecciona la empresa igual que las demás consultas, aunque el servicio viva
   * en otra aplicación. Una versión anterior no lo hacía, con el argumento de
   * que esa aplicación resuelve la empresa por su cuenta —tiene su propio
   * `rutEmpresa`—, pero lo que resuelve es la empresa ACTIVA de la sesión del
   * portal, que es la que dejó la última consulta. O sea que sin seleccionar,
   * esto devuelve los borradores de una empresa que depende de qué se llamó
   * antes: para un RUT que opera cinco, el resultado es arbitrario y nadie se
   * entera, porque un listado de otra empresa se lee perfectamente bien.
   */
  async listBorradores(empresaRut?: string): Promise<BorradorMipyme[]> {
    this.session.assertPuedeEntregarCookieJar();

    return this.session.conEmpresaExclusiva(async () => {
      const empresas = this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
      const resuelta = this.resolverEmpresa(empresas, empresaRut);
      await this.http.postForm(SEL_EMPRESA_URL, { RUT_EMP: resuelta });
      return this.pedirBorradores();
    });
  }

  private async pedirBorradores(): Promise<BorradorMipyme[]> {
    const crudo = await this.http.get(BORRADORES_LISTADO_URL);

    let resp: unknown;
    try {
      resp = JSON.parse(crudo);
    } catch {
      // El servidor de aplicaciones responde HTML en sus errores (404, 500, la
      // página de login). Sin este mensaje, el fallo llegaría como un
      // "Unexpected token <" que no dice nada de lo que pasó.
      throw new Error(
        'La aplicación de borradores del SII no devolvió JSON. Puede ser la sesión '
        + `caída o un cambio del servicio. Respuesta: ${crudo.slice(0, 200)}`);
    }

    const lista = this.datosDeSdi(resp);
    return lista.map(b => ({
      // `ehdr_CODIGO` es el identificador del borrador y `ptdc_CODIGO` el del
      // tipo de documento: los nombres salen de los logs del propio bundle.
      codigo: String(b.ehdr_CODIGO ?? ''),
      tipoDte: b.ptdc_CODIGO !== undefined && b.ptdc_CODIGO !== null
        ? Number(b.ptdc_CODIGO) : null,
      // El resto se publica entero y sin renombrar. Un borrador tiene decenas de
      // campos (`EFXP_*`) que dependen del tipo de documento, y elegir cuáles
      // exponer sería adivinar qué necesita el consumidor.
      campos: b,
    }));
  }

  // La respuesta SDI envuelve los datos y no siempre igual. Se acepta el arreglo
  // directo o dentro de `data`, y CUALQUIER otra forma es un error explícito:
  // devolver [] haría que "el SII contestó otra cosa" y "no hay borradores" se
  // lean idénticos.
  private datosDeSdi(resp: any): Record<string, unknown>[] {
    const datos = Array.isArray(resp) ? resp
      : Array.isArray(resp?.data) ? resp.data
        : Array.isArray(resp?.data?.data) ? resp.data.data : null;

    if (datos === null) {
      const respCode = resp?.metaData?.respCode ?? resp?.respCode;
      const msg = resp?.metaData?.msgError ?? resp?.msgError;
      throw new Error(
        'La aplicación de borradores del SII no devolvió una lista'
        + `${respCode !== undefined ? ` (respCode ${respCode})` : ''}`
        + `${msg ? `: ${String(msg).slice(0, 120)}` : '.'}`);
    }
    return datos;
  }

  // Emisión. `confirmar` es lo único que separa leer de emitir:
  //
  //   confirmar=false → llega hasta la previsualización y devuelve el documento
  //                     armado por el SII. NO emite. Es el default.
  //   confirmar=true  → firma, y eso es un acto tributario real e irreversible
  //                     que notifica al receptor.
  //
  // Los dos pasos van dentro de la MISMA sección crítica a propósito. La
  // empresa activa es estado del servidor: si la previsualización y la firma
  // fueran dos llamadas separadas, otra consulta podría cambiar de empresa en
  // el medio y la firma emitiría desde un contribuyente distinto del que se
  // previsualizó, sin ningún error visible. Por eso tampoco se expone un
  // `firmar(campos)` público: el estado que hace válido a ese `campos` sólo
  // existe adentro de esta sección.
  async emitirDte(params: EmitirDteParams, confirmar = false): Promise<PrevisualizacionDte | DteEmitido> {
    if (!TIPOS_SOPORTADOS.includes(params.tipoDte as (typeof TIPOS_SOPORTADOS)[number])) {
      throw new Error(
        `El tipo de documento ${params.tipoDte} no está soportado: sólo se relevó el formulario ` +
        `de ${TIPOS_SOPORTADOS.join(', ')}. El portal ofrece más tipos (52 guía, 46 factura de ` +
        `compra, 43 liquidación, 110 exportación), pero emitirlos exigiría adivinar sus campos.`
      );
    }
    this.session.assertPuedeEntregarCookieJar();
    // Emitir de verdad exige certificado: la clave tributaria autentica pero no
    // firma, y la firma electrónica avanzada sale del certificado.
    //
    // Este chequeo es imprescindible desde que `assertPuedeEntregarCookieJar`
    // dejó de exigir certificado (ahora la clave también produce el jar). Sin
    // él, una sesión con clave llegaba hasta el POST de firma del portal — y
    // emitir un DTE es un acto tributario irreversible, así que el fallo tiene
    // que ocurrir ANTES de tocar la red, no a mitad del intento.
    //
    // Sólo cuando se va a firmar: la previsualización (`confirmar=false`) no
    // firma nada y funciona bien con clave.
    if (confirmar) this.session.assertPuedeFirmar();

    return this.session.conEmpresaExclusiva(() => this.prepararYEmitir(params, confirmar));
  }

  /**
   * Guarda un DTE como BORRADOR (no lo emite: no es un acto tributario, es
   * reversible). Con `confirmar=false` (default) SIMULA: prepara los campos pero
   * NO postea al CGI de grabado, y devuelve el resumen de lo que se guardaría.
   * Con `confirmar=true` graba el borrador (`mipeGrabaBorrador.cgi`). Si viene
   * `borradorId` (EHDR_CODIGO), edita ese borrador en vez de crear uno nuevo.
   *
   * NO exige certificado: un borrador no se firma. Alcanza la sesión.
   */
  async guardarBorrador(params: EmitirDteParams, confirmar = false, borradorId?: string): Promise<BorradorGuardado> {
    if (!TIPOS_SOPORTADOS.includes(params.tipoDte as (typeof TIPOS_SOPORTADOS)[number])) {
      throw new Error(
        `El tipo de documento ${params.tipoDte} no está soportado para borrador: sólo se relevó el `
        + `formulario de ${TIPOS_SOPORTADOS.join(', ')}.`);
    }
    this.session.assertPuedeEntregarCookieJar();
    return this.session.conEmpresaExclusiva(() => this.prepararYGuardarBorrador(params, confirmar, borradorId));
  }

  // Sel empresa + form + emisor + validación + campos. Lo comparten la emisión y
  // el guardado de borrador: es el mismo formulario del portal, así que un
  // borrador se arma con exactamente los campos que se emitirían.
  private async prepararCampos(params: EmitirDteParams): Promise<{
    empresaRut: string; emisor: EmisorFormulario; totales: TotalesDte; campos: Record<string, string>;
  }> {
    const empresas = this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
    const empresaRut = this.resolverEmpresa(empresas, params.empresaRut);
    await this.http.postForm(SEL_EMPRESA_URL, { RUT_EMP: empresaRut });

    const query: Record<string, string> = { PTDC_CODIGO: String(params.tipoDte) };
    // La nota de crédito "en blanco" es la que sirve para cualquier
    // referencia; sin la plantilla, el CGI devuelve el formulario de factura.
    if (params.tipoDte === 61) query.TIPO_PLANTILLA = 'NC_BLANCO';

    const formHtml = await this.http.get(FORM_EMISION_URL, query);
    this.assertEmpresaSeleccionada(formHtml);
    const emisor = parseEmisorDesdeFormulario(formHtml);

    const totales = calcularTotales(params.lineas);
    this.validarEmision(params, emisor, totales);
    return { empresaRut, emisor, totales, campos: this.armarCamposEmision(params, emisor, totales) };
  }

  private async prepararYGuardarBorrador(
    params: EmitirDteParams, confirmar: boolean, borradorId?: string
  ): Promise<BorradorGuardado> {
    // La preparación (sel empresa, form, validación) es PRE-POST: no grabó nada,
    // así que cualquier error acá es seguro de liberar en la red anti-doble-click.
    const prep = await (async () => {
      try { return await this.prepararCampos(params); }
      catch (e) { throw marcarSeguro(e); }
    })();
    const { empresaRut, emisor, totales, campos } = prep;
    const resumen: ResumenDte = {
      tipoDte: params.tipoDte, emisorRut: empresaRut, emisorRazonSocial: emisor.razonSocial,
      receptorRut: `${params.receptor.rut}-${params.receptor.dv}`, receptorRazonSocial: params.receptor.razonSocial,
      fechaEmision: campos.EFXP_FCH_EMIS ?? '', neto: totales.neto, iva: totales.iva, total: totales.total,
    };

    if (!confirmar) {
      // El dry-run valida CONTRA EL PORTAL, no sólo localmente: postea al preview
      // (ES_BORR=FALSE, que NO graba) igual que la previsualización de emitir, y
      // detecta un rechazo del SII antes de prometer que el grabado saldría. Sin
      // esto, un dry-run "ok" podía terminar en un confirmar:true rechazado.
      const previewHtml = await this.http.postForm(PREVIEW_URL, campos, { charset: 'latin1' });
      this.assertPrevisualizacionValida(previewHtml);
      return { guardado: false, resumen, borradorId: borradorId ?? null };
    }

    // Grabado real: el mismo form, con ES_BORR='TRUE' y el id del borrador a
    // editar (vacío = nuevo). Va a mipeGrabaBorrador.cgi, no al preview.
    const camposBorrador = { ...campos, ES_BORR: 'TRUE', EHDR_CODIGO: borradorId ?? '' };
    const html = await this.http.postForm(GRABA_BORRADOR_URL, camposBorrador, { charset: 'latin1' });
    // La página de éxito trae este texto (relevado de un grabado real). El SII
    // NO devuelve el id del borrador en esta respuesta, así que el éxito se
    // detecta por el mensaje, no por la presencia de un EHDR_CODIGO (que ante un
    // rechazo al EDITAR volvería igual y daría un falso positivo). Ante un
    // rechazo el CGI devuelve el formulario, sin este texto.
    if (!GRABADO_OK.test(html)) {
      // Sin el mensaje de éxito hay dos casos, y sólo uno es seguro de liberar:
      //  - RECHAZO determinístico: el CGI devuelve el formulario de emisión (con
      //    ES_BORR/VIEW_EFXP). No grabó nada → marcar seguro para reintentar.
      //  - AMBIGUO: ni éxito ni el form de vuelta (una variante de mensaje no
      //    cubierta, un HTML inesperado). El grabado PUDO salir, así que NO se
      //    marca: la reserva se mantiene y no se arriesga un segundo borrador.
      const volvioElForm = /name=["']?ES_BORR["']?|VIEW_EFXP|mipeDisplayPreView/i.test(html);
      if (volvioElForm) {
        throw marcarSeguro(new EscrituraRechazadaPorSii(
          'El SII rechazó el guardado del borrador (devolvió el formulario). '
          + 'Revisá los datos del documento; NO se guardó.'));
      }
      throw new EscrituraRechazadaPorSii(
        'Respuesta inesperada del SII al guardar el borrador: no trae ni la confirmación de '
        + 'éxito ni el formulario de rechazo. Pudo haberse grabado o no; verificá con list-borradores.');
    }
    // El id sólo se conoce cuando se EDITÓ (el que entró); en un borrador nuevo
    // el SII no lo devuelve acá y hay que buscarlo con list-borradores.
    return { guardado: true, resumen, borradorId: borradorId ?? null };
  }

  // El cuerpo de la emisión, YA dentro de la sección crítica. Vive aparte para
  // que `verificarFirma` pueda encadenar la previsualización y la firma sin
  // soltar el candado en el medio: la empresa activa es estado del servidor, y
  // soltarlo dejaría que otra consulta la cambiara entre un paso y el
  // siguiente.
  private async prepararYEmitir(
    params: EmitirDteParams,
    confirmar: boolean
  ): Promise<PrevisualizacionDte | DteEmitido> {
    const { empresaRut, emisor, totales, campos } = await this.prepararCampos(params);
    const previewHtml = await this.http.postForm(PREVIEW_URL, campos, { charset: 'latin1' });
    // El CGI no responde con un error cuando el documento no le sirve:
    // devuelve el formulario de vuelta. Sin este chequeo, un rechazo se lee
    // como una previsualización correcta y el paso siguiente firma vacío.
    this.assertPrevisualizacionValida(previewHtml);

    const camposFirma = parseCamposFormulario(previewHtml, 'PreViewDTE');
    const resumen: ResumenDte = {
      tipoDte: params.tipoDte,
      emisorRut: empresaRut,
      emisorRazonSocial: emisor.razonSocial,
      receptorRut: `${params.receptor.rut}-${params.receptor.dv}`,
      receptorRazonSocial: params.receptor.razonSocial,
      // Del documento normalizado por el SII, no de lo que mandamos: si el
      // portal ajustó algo, el resumen tiene que mostrar lo que se va a
      // firmar.
      fechaEmision: camposFirma.EFXP_FCH_EMIS ?? '',
      neto: parseInt(camposFirma.EFXP_MNT_NETO ?? '0', 10),
      iva: parseInt(camposFirma.EFXP_IVA ?? '0', 10),
      total: parseInt(camposFirma.EFXP_MNT_TOTAL ?? '0', 10),
    };

    if (!confirmar) return { emitido: false, resumen, campos: camposFirma };

    // A partir de acá se emite. Tres pasos: el portal arma el XML, el SII lo
    // firma con el certificado centralizado, y el último POST lo envía.
    const firmaHtml = await this.http.postForm(FIRMA_URL, camposFirma, { charset: 'latin1' });
    const folio = await this.firmarYEnviar(firmaHtml);
    return { emitido: true, folio, resumen };
  }

  // Los tres pasos finales, los que efectivamente emiten. Se hace en un método
  // aparte para que el camino sin `confirmar` no pueda entrar acá por descuido.
  private async firmarYEnviar(firmaHtml: string): Promise<number> {
    const { campos, firmado, folio } = await this.firmar(firmaHtml);
    if (!firmado.ok) {
      throw new Error(
        `El SII no firmó el documento. Respondió: ${firmado.detalle}. ` +
        'Suele ser la clave del certificado (SII_CERT_CLAVE_SII). NO se emitió nada.'
      );
    }

    const envio = await this.http.postForm(
      SEND_XML_URL,
      { ...campos, txtSignText: firmado.xml },
      { charset: 'latin1' }
    );

    this.assertEnvioAceptado(envio);
    // Se devuelve el folio PROPUESTO (el de la página de firma), no el asignado:
    // la respuesta de mipeSendXML.cgi no está relevada, así que no se puede leer
    // el folio real de ahí. La tool marca esta salvedad y manda a verificar
    // contra el historial. No afirmar el folio con certeza evita repetir el
    // falso positivo del "folio 21". Cuando se releve el envío, leer el folio de
    // `envio` en vez de reusar el propuesto.
    return folio;
  }

  // Todo el camino hasta la firma, sin enviar. Lo comparten la emisión y
  // `verificarFirma`: si fueran dos implementaciones, la verificación podría dar
  // verde sobre un camino distinto del que emite, que es peor que no tenerla.
  private async firmar(firmaHtml: string): Promise<{
    campos: Record<string, string>;
    folio: number;
    certId: string;
    firmado: { ok: boolean; xml: string; detalle: string };
  }> {
    const campos = parseCamposFormulario(firmaHtml, 'frmSign');
    const xml = campos.txtPlainText;
    const folio = campos.EFXP_FOLIO;
    if (!xml || !folio) {
      throw new Error(
        'El portal no devolvió el XML del documento ni su folio en la página de firma. ' +
        'NO se emitió nada.'
      );
    }

    // La clave se exige ANTES de consultar el certificado: sin ella no se puede
    // firmar, y preguntar primero evita una consulta a la red para terminar
    // fallando igual.
    const clave = this.claveCertificado();
    // El certificado es de la PERSONA autenticada, no de la empresa emisora: es
    // quien firma. Por eso sale de la identidad de la sesión y no de empresaRut.
    const { rut, dv } = this.session.identidad();
    const certId = await this.certificadoCentralizado(rut, dv);

    // El SII firma el XML con el certificado que el contribuyente le tiene
    // cargado. La clave sale del entorno, nunca de los parámetros de la tool.
    const respuesta = await this.http.postForm(
      FIRMA_DIGITAL_URL,
      { nombre: certId, dato: xml, rut, dv, clave, ...NODO_FIRMA_DTE },
      { charset: 'latin1' }
    );

    // El endpoint devuelve el XML firmado; cualquier otra cosa es un rechazo, y
    // enviarla igual mandaría basura al SII como documento tributario.
    const ok = /<Signature|<DTE/i.test(respuesta);
    return {
      campos,
      folio: parseInt(folio, 10),
      certId,
      firmado: { ok, xml: respuesta, detalle: respuesta.slice(0, 200) },
    };
  }

  // Comprueba que la configuración de firma sirve —que hay certificado
  // centralizado y que SII_CERT_CLAVE_SII es la clave correcta— SIN emitir.
  //
  // Se puede porque `postFirmaDigital.cgi` firma pero no emite: el que emite es
  // el POST siguiente, `mipeSendXML.cgi`, al que esta función no llega nunca.
  // Sin esto, la única manera de saber si la clave es la correcta sería emitir
  // un documento tributario real, que es justo lo que no se puede hacer para
  // probar.
  //
  // Arma un documento de verdad porque el SII firma ese XML y no uno cualquiera;
  // el documento queda sin emitir y su folio sin tomar (el SII lo asigna al
  // firmar y enviar, no antes).
  //
  // No lanza cuando la firma falla: devuelve el detalle. Quien verifica una
  // configuración quiere el motivo, no una excepción.
  async verificarFirma(params: EmitirDteParams): Promise<{
    firmaValida: boolean;
    certId?: string;
    detalle: string;
  }> {
    this.session.assertPuedeEntregarCookieJar();
    // Firma un XML de verdad contra el SII (no emite, pero firma), así que exige
    // certificado por el mismo motivo que `emitirDte`: la clave tributaria
    // autentica y no firma. Antes alcanzaba el guard del cookie jar porque ése
    // exigía certificado; ahora que la clave también lo produce, hay que pedirlo
    // acá explícitamente.
    this.session.assertPuedeFirmar();

    return this.session.conEmpresaExclusiva(async () => {
      const previa = await this.prepararYEmitir(params, false);
      if (previa.emitido) {
        // Defensa contra un futuro cambio de `prepararYEmitir`: acá jamás debe
        // venir un documento emitido.
        throw new Error('verificarFirma recibió un documento emitido; abortando por seguridad.');
      }

      const firmaHtml = await this.http.postForm(FIRMA_URL, previa.campos, { charset: 'latin1' });
      const { certId, firmado } = await this.firmar(firmaHtml);
      return {
        firmaValida: firmado.ok,
        certId,
        detalle: firmado.ok
          ? 'El SII firmó el documento de prueba: la clave y el certificado son correctos. ' +
            'No se emitió nada.'
          : `El SII no firmó: ${firmado.detalle}`,
      };
    });
  }

  private claveCertificado(): string {
    const clave = this.session.claveCertificadoSii();
    if (!clave) {
      throw new Error(
        'Falta SII_CERT_CLAVE_SII: la clave del certificado digital que el contribuyente ' +
        'tiene cargado EN EL SII, con la que el SII firma el documento. No se usa ' +
        'SII_CERT_PASSWORD en su lugar aunque esté configurada: ese es el certificado local, ' +
        'que puede ser otro archivo o el mismo cargado con otra clave. Si son la misma clave, ' +
        'configurá igual esta variable.'
      );
    }
    return clave;
  }

  private async certificadoCentralizado(rut: string, dv: string): Promise<string> {
    const respuesta = await this.http.get(CERT_DIGITAL_URL, { rut, dv });
    let certs: Array<{ nombre?: string }> = [];
    try {
      certs = JSON.parse(respuesta);
    } catch {
      throw new Error(
        `No se pudo consultar el certificado digital centralizado; el SII respondió ` +
        `${respuesta.slice(0, 120)}. NO se emitió nada.`
      );
    }
    const certId = certs?.[0]?.nombre;
    if (!certId) {
      throw new Error(
        'Este RUT no tiene un certificado digital cargado en el SII (certificado ' +
        'centralizado), que es lo que permite firmar los DTE del portal desde acá. ' +
        'La otra modalidad del portal firma con un plug-in del navegador y no se puede ' +
        'replicar por HTTP. NO se emitió nada.'
      );
    }
    return certId;
  }

  // El criterio de éxito del envío está fijado con lo que el portal responde
  // cuando rechaza, que es lo mismo que en los otros pasos: una página con un
  // alert(). Se prefiere fallar ante lo desconocido antes que dar por emitido un
  // documento que no lo está — la lección del folio 21.
  private assertEnvioAceptado(html: string): void {
    const alerta = /alert\s*\(\s*'((?:[^'\\]|\\.)*)'\s*\)/i.exec(html)?.[1];
    if (alerta) {
      throw new Error(
        `El SII rechazó el envío del documento: ${decodificarEntidades(alerta.replace(/\\n/g, ' ').trim())}.`
      );
    }
    if (/name=["']frmSign["']/i.test(html)) {
      throw new Error(
        'El portal volvió a pedir la firma, así que el documento NO se emitió. ' +
        'Revisá la clave del certificado antes de reintentar.'
      );
    }
  }

  // Reproduce las validaciones del `validaFacEx()` del portal ANTES de postear.
  // No es redundante: un POST inválido no falla, devuelve el formulario de
  // vuelta, así que sin esto el error aparecería como "no se pudo previsualizar"
  // sin decir qué campo faltaba.
  private validarEmision(params: EmitirDteParams, emisor: EmisorFormulario, totales: TotalesDte): void {
    const faltan: string[] = [];
    const exigir = (valor: string | undefined, glosa: string) => {
      if (!valor || valor.trim().length === 0) faltan.push(glosa);
    };

    exigir(emisor.razonSocial, 'Razón Social del contribuyente emisor');
    exigir(emisor.giro, 'Giro del contribuyente emisor');
    exigir(emisor.acteco, 'Código de Actividad Económica del emisor');
    exigir(emisor.direccion, 'Dirección del contribuyente emisor');
    exigir(emisor.comuna, 'Comuna del contribuyente emisor');
    exigir(params.ciudadEmisor ?? emisor.ciudad ?? emisor.comuna, 'Ciudad del contribuyente emisor');

    exigir(params.receptor.razonSocial, 'Razón Social del contribuyente receptor');
    exigir(params.receptor.giro, 'Giro del contribuyente receptor');
    exigir(params.receptor.direccion, 'Dirección del contribuyente receptor');
    exigir(params.receptor.comuna, 'Comuna del contribuyente receptor');
    exigir(params.receptor.ciudad, 'Ciudad del contribuyente receptor');
    if (!rutEsValido(params.receptor.rut, params.receptor.dv)) {
      faltan.push(`RUT receptor inválido (${params.receptor.rut}-${params.receptor.dv})`);
    }

    if (params.lineas.length === 0) faltan.push('Al menos una línea de detalle');
    params.lineas.forEach((linea, i) => {
      exigir(linea.nombre, `Nombre del ítem ${i + 1} del detalle`);
      if (linea.nombre && linea.nombre.length > 25) {
        faltan.push(`El nombre del ítem ${i + 1} supera los 25 caracteres que acepta el portal`);
      }
      if (!(linea.cantidad >= 1)) faltan.push(`Cantidad del ítem ${i + 1} debe ser mayor a 0`);
      if (!(linea.precioUnitario >= 0)) faltan.push(`Precio del ítem ${i + 1} debe ser mayor o igual a 0`);
    });

    if (totales.total < 1) faltan.push('El total del documento debe ser mayor a 0');
    // El caso que hace fallar una prueba de $1: IVA = round(neto * 0,19), así
    // que con neto 1 o 2 el IVA da 0 y el portal rechaza. Se explica acá en vez
    // de dejar que el CGI devuelva el formulario sin decir por qué.
    if (params.tipoDte === 33 && totales.iva < 1) {
      faltan.push(
        `El IVA debe ser mayor a 0 y con un neto de ${totales.neto} da 0 ` +
        `(IVA = redondeo del 19% del neto). El neto mínimo emisible en una factura afecta es 3.`
      );
    }

    if (params.tipoDte === 61) {
      const ref = params.referencias?.[0];
      // Una nota de crédito sin referencia no dice qué documento corrige: el
      // portal la exige y el SII la necesita para cruzarla.
      if (!ref) {
        faltan.push('Una nota de crédito exige al menos una referencia al documento que corrige');
      } else {
        if (!(ref.folio > 0)) faltan.push('El folio de la referencia debe ser numérico y mayor a 0');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ref.fecha)) faltan.push('La fecha de la referencia debe ser AAAA-MM-DD');
        if (!ref.codigo) faltan.push('El código de la referencia (1 anula, 2 corrige texto, 3 corrige montos)');
      }
    }

    if (faltan.length > 0) {
      throw new Error(
        `El portal mipyme rechazaría este documento. Falta o está mal: ${faltan.join('; ')}.`
      );
    }
  }

  // El POST reproduce lo que manda el navegador: 53 campos para una factura de
  // una línea, medido serializando el formulario real. Los checkbox sin marcar
  // NO viajan (por eso no aparecen acá), y los valores del emisor se reenvían
  // tal como el portal los entregó.
  private armarCamposEmision(
    params: EmitirDteParams,
    emisor: EmisorFormulario,
    totales: TotalesDte
  ): Record<string, string> {
    const campos: Record<string, string> = {
      esCRED_EC: 'FALSE',
      esFACT_TUR: 'FALSE',
      PTDC_CODIGO: String(params.tipoDte),
      CANT_DET: String(params.lineas.length),
      EFXP_CDG_SII_SUCUR: emisor.codigoSucursal,
      ES_BORR: 'FALSE',
      EHDR_CODIGO: '',
      EFXP_FCH_EMIS: params.fechaEmision ?? emisor.fechaEmision,
      EFXP_RZN_SOC: emisor.razonSocial,
      EFXP_DIR_ORIGEN_DEFUALT: '',
      EFXP_DIR_ORIGEN: emisor.direccion,
      EFXP_CMNA_ORIGEN: emisor.comuna,
      EFXP_CIUDAD_ORIGEN: params.ciudadEmisor ?? emisor.ciudad ?? emisor.comuna,
      // "Del Giro" en los dos: es el default del portal y el caso normal.
      EFXP_TIPOVENTA_SELECT: '1',
      EFXP_EMAIL_EMISOR: emisor.email,
      EFXP_FONO_EMISOR: '',
      EFXP_GIRO_EMIS: emisor.giro,
      EFXP_ACTECO: emisor.acteco,
      EFXP_ACTECO_SELECT: emisor.acteco,
      EFXP_RUT_RECEP: params.receptor.rut,
      EFXP_DV_RECEP: params.receptor.dv,
      EFXP_RZN_SOC_RECEP: params.receptor.razonSocial,
      EFXP_TIPOCOMPRA_SELECT: '1',
      EFXP_DIR_RECEP_DEFUALT: '',
      EFXP_DIR_RECEP: params.receptor.direccion,
      EFXP_CMNA_RECEP: params.receptor.comuna,
      EFXP_CIUDAD_RECEP: params.receptor.ciudad,
      EFXP_GIRO_RECEP_DEFUALT: '',
      EFXP_GIRO_RECEP: params.receptor.giro,
      EFXP_CONTACTO: '',
      EFXP_RUT_SOLICITA: '',
      EFXP_DV_SOLICITA: '',
      EFXP_RUT_TRANSPORTE: '',
      EFXP_DV_TRANSPORTE: '',
      EFXP_PATENTE: '',
      EFXP_RUT_CHOFER: '',
      EFXP_DV_CHOFER: '',
      EFXP_NOMBRE_CHOFER: '',
      EFXP_FMA_PAGO: String(params.formaPago ?? 2),
      EFXP_SUBTOTAL: String(totales.neto),
      EFXP_PCT_DESC: '0',
      EFXP_MNT_DESC: '0',
      IVA_TEMP: '',
      MNT_NETO_TEMP: '',
      EFXP_MNT_NETO: String(totales.neto),
      EFXP_TASA_IVA: '19',
      EFXP_IVA: String(totales.iva),
      EFXP_MNT_TOTAL: String(totales.total),
    };

    // Las líneas van numeradas con dos dígitos desde 01.
    params.lineas.forEach((linea, i) => {
      const n = String(i + 1).padStart(2, '0');
      campos[`EFXP_NMB_${n}`] = linea.nombre;
      campos[`EFXP_QTY_${n}`] = String(linea.cantidad);
      campos[`EFXP_UNMD_${n}`] = linea.unidad ?? '';
      campos[`EFXP_PRC_${n}`] = String(linea.precioUnitario);
      campos[`EFXP_PCTD_${n}`] = '';
      campos[`EFXP_SUBT_${n}`] = String(totales.subtotales[i]);
    });

    // El bloque de referencias sólo viaja si hay referencias, y entonces con su
    // checkbox marcado: sin REF_SI_NO el CGI ignora los campos.
    if (params.referencias && params.referencias.length > 0) {
      campos.REF_SI_NO = 'SiChecked';
      params.referencias.slice(0, 3).forEach((ref, i) => {
        const n = String(i + 1).padStart(3, '0');
        campos[`EFXP_TPO_DOC_REF_${n}`] = String(ref.tipoDoc);
        campos[`EFXP_FOLIO_REF_${n}`] = String(ref.folio);
        campos[`EFXP_FCH_REF_${n}`] = ref.fecha;
        campos[`EFXP_RAZON_REF_${n}`] = ref.razon ?? '';
        campos[`EFXP_IND_GLOBAL_${n}`] = '';
        if (ref.codigo) campos[`EFXP_CODIGO_REF_${n}`] = String(ref.codigo);
      });
    }

    return campos;
  }

  // El CGI responde 200 aunque rechace el documento, así que el código de
  // respuesta no distingue nada. La marca es de qué página se trata.
  //
  // Cuando rechaza, devuelve una página <TITLE>Redireccionando</TITLE> cuyo
  // único contenido útil es un `alert('Debe ingresar el campo : X')` seguido de
  // un `history.go(-1)`. O sea: **el motivo del rechazo viaja dentro del
  // JavaScript**, y quedarse con el título reporta "devolvió Redireccionando",
  // que no dice nada. Se extrae el alert.
  private assertPrevisualizacionValida(html: string): void {
    if (/name=["']PreViewDTE["']/i.test(html)) return;

    const alerta = /alert\s*\(\s*'((?:[^'\\]|\\.)*)'\s*\)/i.exec(html)?.[1];
    const motivo = alerta
      ? decodificarEntidades(alerta.replace(/\\n/g, ' ').trim())
      : `devolvió "${decodificarEntidades(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? 'una página desconocida')}"`;

    throw new Error(
      `El portal mipyme rechazó el documento: ${motivo}. NO se emitió nada.`
    );
  }

  // Con una sola empresa no hay ambigüedad y se resuelve sola, que es el
  // comportamiento que tenía el camino de navegador. Con varias hay que elegir:
  // el error da las dos salidas (parámetro o variable de entorno) y la lista, del
  // mismo modo que SessionManager.selectEmpresa — son las empresas del propio
  // contribuyente autenticado, las mismas que devuelve sii_mipyme_list_empresas.
  private resolverEmpresa(empresas: Empresa[], pedida?: string): string {
    if (pedida) {
      if (!empresas.some(e => e.rut === pedida)) {
        throw new Error(
          `La empresa ${pedida} no está entre las que este RUT puede operar en el portal ` +
          `mipyme. Disponibles: ${empresas.map(e => e.rut).join(', ')}`
        );
      }
      return pedida;
    }
    if (empresas.length === 1) return empresas[0].rut;
    throw new Error(
      `Este RUT opera ${empresas.length} empresas en el portal mipyme: pasá empresa_rut en la ` +
      `llamada o configura SII_EMPRESA_RUT, con uno de: ${empresas.map(e => e.rut).join(', ')}`
    );
  }

  private params(filtros: FiltrosDteEmitidos, pagina: number): Record<string, string> {
    return {
      RUT_RECP: filtros.receptorRut ?? '',
      FOLIO: filtros.folio ? String(filtros.folio) : '',
      RZN_SOC: '',
      FEC_DESDE: filtros.fechaDesde ? this.aFechaSii(filtros.fechaDesde) : '',
      FEC_HASTA: filtros.fechaHasta ? this.aFechaSii(filtros.fechaHasta) : '',
      TPO_DOC: filtros.tipoDte ? String(filtros.tipoDte) : '',
      ESTADO: '',
      ORDEN: '',
      NUM_PAG: String(pagina),
    };
  }

  // Los nombres de los parámetros salen de la URL que arma el propio portal:
  // `RUT_EMI` acá contra `RUT_RECP` en emitidos. El resto coincide.
  private paramsRecibidos(filtros: FiltrosDteRecibidos, pagina: number): Record<string, string> {
    return {
      RUT_EMI: filtros.emisorRut ?? '',
      FOLIO: filtros.folio ? String(filtros.folio) : '',
      RZN_SOC: '',
      FEC_DESDE: filtros.fechaDesde ? this.aFechaSii(filtros.fechaDesde) : '',
      FEC_HASTA: filtros.fechaHasta ? this.aFechaSii(filtros.fechaHasta) : '',
      TPO_DOC: filtros.tipoDte ? String(filtros.tipoDte) : '',
      ESTADO: '',
      ORDEN: '',
      NUM_PAG: String(pagina),
    };
  }

  private aFechaSii(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  // El CGI responde 200 con un alert() de JavaScript cuando falta el paso de
  // selección de empresa. Es un fallo reconocible y hay que reportarlo como tal:
  // dejarlo pasar devolvería cero documentos, que se lee como "esta empresa no
  // emitió nada" en un período que puede tener cientos.
  private assertEmpresaSeleccionada(html: string): void {
    if (/no ha seleccionado una Empresa/i.test(html)) {
      const codigo = html.match(/CODIGO:\s*([\d.\-]+)/)?.[1] ?? 'sin código';
      throw new Error(
        `El portal mipyme respondió que no ha seleccionado una Empresa (código ${codigo}). ` +
        `La selección se perdió entre el POST y la consulta: reintentá la operación.`
      );
    }
  }

  private parseEmpresas(html: string): Empresa[] {
    const empresas: Empresa[] = [];
    // El texto se corta con un LOOKAHEAD, no consumiendo el `<`. Los `<option>`
    // del SII no cierran, así que un patrón que se coma el `<` del siguiente
    // avanza el lastIndex más allá de su apertura y se saltea una empresa de
    // cada dos: cinco en el combo, tres devueltas, sin ningún error. Medido
    // contra el portal real. La fixture conserva los `<option>` sin cerrar.
    for (const m of html.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)(?=<)/g)) {
      const rut = m[1].trim();
      if (!/^\d{5,}-[\dkK]$/.test(rut)) continue;
      // El texto de la opción repite el RUT al final ("EMPRESA SPA 22222222-2"):
      // se quita para que el nombre sea sólo el nombre.
      const nombre = this.decodificar(m[2]).replace(/\s*\d{5,}-[\dkK]\s*$/, '').trim();
      empresas.push({ rut, nombre: nombre || rut });
    }

    // Un combo sin opciones no es "esta persona no opera ninguna empresa": es el
    // CGI devolviendo otra página (sesión caída, WAF, rediseño). Devolver [] haría
    // los dos casos indistinguibles.
    if (empresas.length === 0) {
      throw new Error(
        'El portal mipyme no devolvió ninguna empresa en la página de selección. ' +
        'Puede ser la sesión caída o un cambio del portal; no significa que este RUT no opere empresas.'
      );
    }
    return empresas;
  }

  // ATENCIÓN al `<td>` sin cerrar: la celda del RUT del receptor viene como
  // `<td>77777777-7<td>RAZON SOCIAL</td>`, o sea HTML malformado que manda el
  // propio SII. Cortar cada celda en `</td>` **o** en el `<td` siguiente es lo
  // que hace que salgan las 8 columnas del header; exigir el cierre devuelve 7,
  // pierde el RUT y corre todo un lugar, dejando `receptorRut` poblado con la
  // razón social y sin ningún error visible. Hay una fixture que conserva la
  // malformación y un test que fija las 8 columnas.
  private parseHistorial(html: string): DteEmitidoMipyme[] {
    const docs: DteEmitidoMipyme[] = [];
    // Filas que SON de datos (traen el link al detalle) pero que el parser no
    // logró representar. No se pueden saltear en silencio: si el CGI cambia el
    // href o el orden de las columnas, cien documentos se convertirían en una
    // lista vacía que se lee como "esta empresa no emitió nada". Es el mismo
    // vacío ambiguo que el proyecto cierra en el RCV y en Consultas DTE.
    let filasNoInterpretadas = 0;

    for (const fila of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const bruto = fila[0];
      // Marca de fila de datos, independiente de que el parseo salga bien: es el
      // enlace de la columna "Ver". Así el encabezado y las filas decorativas no
      // cuentan como fallos, y una fila de datos que no rinde sí.
      const esFilaDeDatos = /mipeGesDocEmi\.cgi/i.test(bruto);

      const celdas = [...bruto.matchAll(/<td[^>]*>([\s\S]*?)(?=<\/td>|<td)/gi)]
        .map(c => this.decodificar(c[1].replace(/<[^>]*>/g, ' ')).trim());

      // [0]=Ver (link, sin texto) [1]=RUT receptor [2]=razón social
      // [3]=tipo de documento [4]=folio [5]=fecha [6]=monto [7]=estado
      const codigo = bruto.match(/[?&]CODIGO=(\d+)/)?.[1];
      if (celdas.length < 8 || !/^\d+$/.test(celdas[4]) || !codigo) {
        if (esFilaDeDatos) filasNoInterpretadas++;
        continue;
      }

      docs.push({
        receptorRut: celdas[1],
        receptorNombre: celdas[2],
        tipoDteNombre: celdas[3],
        tipoDte: TIPO_DTE_NOMBRES[celdas[3]] ?? 0,
        folio: parseInt(celdas[4], 10),
        // El HTML trae AAAA-MM-DD y montos sin separador de miles, a diferencia
        // de la tabla renderizada (dd/mm/aaaa con puntos). Se preserva el
        // formato del origen en vez de reformatear.
        fecha: celdas[5],
        monto: parseInt(celdas[6].replace(/\./g, ''), 10) || 0,
        estado: celdas[7],
        codigo,
      });
    }

    if (filasNoInterpretadas > 0) {
      throw new Error(
        `El portal mipyme devolvió ${filasNoInterpretadas} fila(s) de documentos que este parser ` +
        `no pudo interpretar (se interpretaron ${docs.length}). El formato del historial pudo ` +
        `cambiar: revisar el parseo antes de confiar en el resultado.`
      );
    }
    return docs;
  }

  // Igual que el de emitidos, con dos diferencias que vienen del portal: la
  // marca de fila de datos es `mipeGesDocRcp.cgi` y la contraparte es el EMISOR.
  // Se repite el cuerpo en vez de parametrizar el de emitidos: son dos tablas
  // distintas del SII que hoy coinciden en forma, y unificarlas haría que un
  // cambio en una arrastrara silenciosamente a la otra.
  private parseHistorialRecibidos(html: string): DteRecibidoMipyme[] {
    const docs: DteRecibidoMipyme[] = [];
    let filasNoInterpretadas = 0;

    for (const fila of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const bruto = fila[0];
      const esFilaDeDatos = /mipeGesDocRcp\.cgi/i.test(bruto);

      const celdas = [...bruto.matchAll(/<td[^>]*>([\s\S]*?)(?=<\/td>|<td)/gi)]
        .map(c => this.decodificar(c[1].replace(/<[^>]*>/g, ' ')).trim());

      // [0]=Ver (link) [1]=RUT emisor [2]=razón social [3]=tipo de documento
      // [4]=folio [5]=fecha [6]=monto [7]=estado
      const codigo = bruto.match(/[?&]CODIGO=(\d+)/)?.[1];
      if (celdas.length < 8 || !/^\d+$/.test(celdas[4]) || !codigo) {
        if (esFilaDeDatos) filasNoInterpretadas++;
        continue;
      }

      docs.push({
        emisorRut: celdas[1],
        emisorNombre: celdas[2],
        tipoDteNombre: celdas[3],
        tipoDte: TIPO_DTE_NOMBRES[celdas[3]] ?? 0,
        folio: parseInt(celdas[4], 10),
        fecha: celdas[5],
        monto: parseInt(celdas[6].replace(/\./g, ''), 10) || 0,
        estado: celdas[7],
        codigo,
      });
    }

    // Mismo criterio que emitidos: una fila que ES de datos y que el parser no
    // supo leer no se saltea en silencio. Cien documentos convertidos en lista
    // vacía se leen como "esta empresa no recibió nada".
    if (filasNoInterpretadas > 0) {
      throw new Error(
        `El portal mipyme devolvió ${filasNoInterpretadas} fila(s) de documentos recibidos que ` +
        `este parser no pudo interpretar (se interpretaron ${docs.length}). El formato del ` +
        `historial pudo cambiar: revisar el parseo antes de confiar en el resultado.`
      );
    }
    return docs;
  }

  // El total de páginas se cuenta de los ENLACES de paginación (`NUM_PAG=n`), no
  // de la leyenda "Página 1 de 3": medido contra el portal real, esa leyenda
  // viaja DENTRO de un comentario HTML, así que cualquier limpieza de tags la
  // borra — la primera versión de esto devolvía null en vivo mientras el test
  // pasaba contra una fixture que la tenía visible.
  //
  // Null cuando no hay enlaces y no se puede afirmar nada. No se devuelve 1:
  // asegurar "hay una sola página" sin saberlo haría que un historial largo
  // parezca completo, que es el vacío ambiguo de siempre.
  private parseTotalPaginas(html: string): number | null {
    const paginas = [...html.matchAll(/[?&]NUM_PAG=(\d+)/g)].map(m => parseInt(m[1], 10));
    if (paginas.length === 0) return null;
    return Math.max(...paginas);
  }

  // Las entidades HTML de los CGI legacy vienen sin decodificar. Sólo se
  // traducen las que aparecen en estos campos (nombres de empresa y de tipos de
  // documento); no hace falta un decodificador general.
  //
  // `&amp;` va ÚLTIMO y tiene que seguir yendo último: si se resolviera primero,
  // un `&amp;aacute;` del origen quedaría como `&aacute;` y la pasada siguiente
  // lo convertiría en `á`, decodificando dos veces algo que el SII escribió
  // escapado. Cualquier entidad nueva se agrega ARRIBA de esa línea.
  private decodificar(texto: string): string {
    return texto
      .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
      .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
      .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
      .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
  }
}
