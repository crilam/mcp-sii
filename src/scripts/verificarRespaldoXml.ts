import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { RegistroSesiones, EjecutorSesion } from '../registroSesiones';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';
import { soloCuerpoRut, MipymeHttpScraper, MAX_TRAMOS_ABSOLUTO } from '../scrapers/mipymeHttp';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { Browser } from '../browser';
import { recorrerConRitmo, PAUSA_POR_DEFECTO_MS } from '../ritmoSii';
import { rutEsValido } from '../rut';

// Verifica `respaldo-xml` contra el SII real, por el handler REST.
//
// El criterio no es "responde ok": es que lo devuelto SEA un SetDTE con
// documentos adentro. El portal contesta 200 con HTML tanto cuando falla como
// cuando el rango excede su tope de 20 documentos, así que un chequeo por status
// dejaría pasar una página de error convertida en "respaldo".
//
//   VERIF_EMPRESA  RUT de la empresa (obligatorio si el perfil opera varias)
//   VERIF_ORIGEN   `recibidos` (default) o `emitidos`
//   VERIF_DESDE    inicio del rango, YYYY-MM-DD (default: primer día del mes pasado)
//   VERIF_HASTA    fin del rango (default: último día del mes pasado)
//   VERIF_SALIDA   directorio donde dejar los XML bajados (modo una consulta) o
//                  el reporte del plan (modo plan)
//   VERIF_CONTRAPARTE  RUT de la contraparte (emisor si recibidos)
//   VERIF_RZN_SOC      razón social de la contraparte
//   VERIF_FOLIO        folio inicial (solo = ese folio exacto)
//   VERIF_FOLIO_HASTA  folio final del rango
//   VERIF_TIPO_DTE     tipo de documento (33, 34, 61...). Combinado con
//                      VERIF_FOLIO/VERIF_FOLIO_HASTA o VERIF_CONTRAPARTE es
//                      justo la combinación que usa el tercer nivel de troceo
//                      del respaldo XML (folio para emitidos, contraparte
//                      para recibidos) y que HOY NO está verificada
//                      end-to-end contra el SII — correr este script con las
//                      dos combinaciones antes de prender
//                      RESPALDO_XML_TERCER_NIVEL=1 en un ambiente real.
//   VERIF_PLAN         ruta a un JSON con VARIAS consultas para correr en la
//                      MISMA corrida y la MISMA sesión del SII (ver más abajo).
//
// --- Por qué existe el modo plan ------------------------------------------
//
// Cada corrida de este script arma un `Browser` nuevo (un contexto nuevo, un
// login nuevo al SII) porque `crearRegistroSesionesSii` así lo garantiza por
// diseño — compartir contexto entre RUTs fue un bug real (ver
// `registroSesionesSii.ts`). Eso es correcto DENTRO de un proceso, pero
// convierte "verificar varias combinaciones de filtros" en "encadenar quince
// logins seguidos", que es justo el patrón que el SII bloquea (sesiones
// simultáneas por RUT, error `01.01.190.500.720.27`, ver `erroresConsulta.ts`).
// Y peor: una ráfaga así una vez dio resultados DISTINTOS para el mismo mes y
// el mismo tipo de documento en corridas consecutivas (3 documentos contra 7),
// sin ninguna página de error de por medio — la herramienta de medición
// alteraba lo que medía.
//
// El modo plan (`VERIF_PLAN`) resuelve esto ejecutando TODAS las consultas del
// plan dentro de UN SOLO proceso, contra el MISMO `SessionManager` (un solo
// login), con la pausa de `ritmoSii.ts` entre cada una y un solo archivo de
// salida donde se puedan comparar. El modo de una consulta (las variables
// VERIF_* de arriba, sin VERIF_PLAN) sigue funcionando exactamente igual que
// antes: hay comandos ya escritos contra él.
const NOMBRE = (process.argv[2] ?? 'certificado') as NombrePerfil;
const SALIDA = process.env.VERIF_SALIDA;

// `Number("abc")` es NaN, y NaN pasa cualquier `if` de "está definido": llegaría
// como `folio_desde: NaN` y saldría un 400 del schema en vez de un mensaje que
// diga qué variable está mal escrita.
function numeroDe(variable: string): number | undefined {
  const crudo = process.env[variable];
  if (!crudo) return undefined;
  const n = Number(crudo);
  if (!Number.isFinite(n)) throw new Error(`${variable} tiene que ser un número; se recibió "${crudo}".`);
  return n;
}

function mesPasado(): { desde: string; hasta: string } {
  const hoy = new Date();
  const inicio = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1));
  const fin = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0));
  return { desde: inicio.toISOString().slice(0, 10), hasta: fin.toISOString().slice(0, 10) };
}

// --- Filtros compartidos entre el modo de una consulta y el modo plan -----

// Lo que trae CADA consulta de un plan (o las variables VERIF_* del modo de
// una consulta), antes de aplicarle los defaults y validarla.
export interface FiltrosCrudos {
  origen?: string;
  desde?: string;
  hasta?: string;
  tipo_dte?: number;
  folio?: number;
  folio_hasta?: number;
  contraparte?: string;
  rzn_soc?: string;
  max_tramos?: number;
}

export interface FiltrosNormalizados {
  origen: 'emitidos' | 'recibidos';
  desde: string;
  hasta: string;
  tipo_dte?: number;
  folio?: number;
  folio_hasta?: number;
  contraparte?: string;
  rzn_soc?: string;
  max_tramos?: number;
}

// Normaliza Y VALIDA una consulta (las variables VERIF_* del modo de una
// consulta, o UNA consulta de un plan) con los MISMOS invariantes que el
// schema zod de `POST /v1/mipyme/respaldo-xml` (ver
// core/schemas/mipyme.ts y rest/rutas/mipyme.ts). El modo plan NO pasa por
// esa ruta REST —lo haría perder el reuso de sesión, que es el punto entero
// de este cambio—, pero tiene que RECHAZAR lo mismo que ella rechaza: un
// plan que acepta filtros que la ruta real rechazaría termina midiendo algo
// que esa ruta nunca haría.
//
// Se valida temprano y con el ÍNDICE de la consulta en el mensaje (via
// `etiqueta`) porque la alternativa —dejar que reviente más abajo en el
// scraper o en el catch genérico de `consultarRespaldoXml`— da un error
// `ERROR` sin decir CUÁL de las N consultas del plan estaba mal escrita.
//
// Invariantes de la ruta REST que replica:
//   - origen: sólo "emitidos"/"recibidos" (normalizado acá desde siempre).
//   - fecha_desde/fecha_hasta: formato YYYY-MM-DD y fecha real de calendario.
//   - fecha_desde <= fecha_hasta.
//   - tipo_dte: entero.
//   - folio_desde/folio_hasta: enteros positivos.
//   - folio_hasta requiere folio_desde, y folio_desde <= folio_hasta.
//   - contraparte_rut: forma de RUT (con o sin DV) y, si trae DV, que sea
//     válido.
//   - razon_social: no vacía (tras trim) y hasta 100 caracteres.
//   - max_tramos: entero entre 1 y 48.
// Lo único que NO se replica es la resolución de `empresa_rut` cuando se
// omite (la ruta la resuelve mirando qué empresas opera el RUT en el
// portal): esa resolución necesita la sesión ya autenticada, así que no hay
// forma de validarla sin hacer la llamada — no es un invariante de FORMA
// como los de arriba, es una consulta en sí misma.
export function normalizarFiltros(bruto: FiltrosCrudos, etiqueta: string): FiltrosNormalizados {
  const rango = mesPasado();

  // Chequeo de TIPO antes que de valor: un JSON de plan no tiene el tipado de
  // TypeScript de `FiltrosCrudos` detrás — un `origen` numérico o un objeto
  // llega tal cual del `JSON.parse`, y `.toLowerCase()` sobre eso revienta con
  // un `TypeError` que no dice CUÁL consulta ni CUÁL campo estaba mal.
  if (bruto.origen != null && typeof bruto.origen !== 'string') {
    throw new Error(`${etiqueta}.origen tiene que ser un string; se recibió ${JSON.stringify(bruto.origen)}.`);
  }
  const origenCrudo = (bruto.origen ?? 'recibidos').toLowerCase();
  if (origenCrudo !== 'emitidos' && origenCrudo !== 'recibidos') {
    throw new Error(
      `${etiqueta}.origen="${bruto.origen}" no es válido: sólo "emitidos" o "recibidos" ` +
      `(la ruta REST trata cualquier otro valor como "recibidos" en silencio, y este script no lo repite).`
    );
  }
  const origen = origenCrudo as 'emitidos' | 'recibidos';

  if (bruto.desde != null && typeof bruto.desde !== 'string') {
    throw new Error(`${etiqueta}.desde tiene que ser un string; se recibió ${JSON.stringify(bruto.desde)}.`);
  }
  if (bruto.hasta != null && typeof bruto.hasta !== 'string') {
    throw new Error(`${etiqueta}.hasta tiene que ser un string; se recibió ${JSON.stringify(bruto.hasta)}.`);
  }
  const desde = bruto.desde ?? rango.desde;
  const hasta = bruto.hasta ?? rango.hasta;
  validarFecha(desde, `${etiqueta}.desde`);
  validarFecha(hasta, `${etiqueta}.hasta`);
  if (desde > hasta) {
    throw new Error(`${etiqueta}: desde (${desde}) no puede ser posterior a hasta (${hasta}).`);
  }

  if (bruto.tipo_dte != null && !Number.isInteger(bruto.tipo_dte)) {
    throw new Error(`${etiqueta}.tipo_dte tiene que ser un entero; se recibió ${bruto.tipo_dte}.`);
  }

  if (bruto.folio != null && (!Number.isInteger(bruto.folio) || bruto.folio <= 0)) {
    throw new Error(`${etiqueta}.folio tiene que ser un entero positivo; se recibió ${bruto.folio}.`);
  }
  if (bruto.folio_hasta != null && (!Number.isInteger(bruto.folio_hasta) || bruto.folio_hasta <= 0)) {
    throw new Error(`${etiqueta}.folio_hasta tiene que ser un entero positivo; se recibió ${bruto.folio_hasta}.`);
  }
  if (bruto.folio_hasta != null && bruto.folio == null) {
    throw new Error(`${etiqueta}.folio_hasta requiere folio (el folio inicial del rango).`);
  }
  if (bruto.folio != null && bruto.folio_hasta != null && bruto.folio > bruto.folio_hasta) {
    throw new Error(`${etiqueta}: folio (${bruto.folio}) no puede ser mayor que folio_hasta (${bruto.folio_hasta}).`);
  }

  if (bruto.contraparte != null && typeof bruto.contraparte !== 'string') {
    throw new Error(`${etiqueta}.contraparte tiene que ser un string; se recibió ${JSON.stringify(bruto.contraparte)}.`);
  }
  let contraparte = bruto.contraparte;
  if (contraparte != null) {
    contraparte = contraparte.replace(/\./g, '').trim();
    if (!/^\d{5,9}(-[\dkK])?$/.test(contraparte)) {
      throw new Error(
        `${etiqueta}.contraparte tiene que ser un RUT (con o sin dígito verificador), ` +
        `por ejemplo 77777777-7; se recibió "${bruto.contraparte}".`
      );
    }
    if (contraparte.includes('-')) {
      const [cuerpo, dv] = contraparte.split('-');
      if (!rutEsValido(cuerpo, dv)) {
        throw new Error(`${etiqueta}.contraparte: el dígito verificador no corresponde al RUT "${bruto.contraparte}".`);
      }
    }
  }

  if (bruto.rzn_soc != null && typeof bruto.rzn_soc !== 'string') {
    throw new Error(`${etiqueta}.rzn_soc tiene que ser un string; se recibió ${JSON.stringify(bruto.rzn_soc)}.`);
  }
  let rznSoc = bruto.rzn_soc;
  if (rznSoc != null) {
    rznSoc = rznSoc.trim();
    if (rznSoc.length === 0) throw new Error(`${etiqueta}.rzn_soc no puede ser vacía.`);
    if (rznSoc.length > 100) throw new Error(`${etiqueta}.rzn_soc no puede superar los 100 caracteres.`);
  }

  if (bruto.max_tramos != null
    && (!Number.isInteger(bruto.max_tramos) || bruto.max_tramos < 1 || bruto.max_tramos > MAX_TRAMOS_ABSOLUTO)) {
    throw new Error(
      `${etiqueta}.max_tramos tiene que ser un entero entre 1 y ${MAX_TRAMOS_ABSOLUTO}; ` +
      `se recibió ${bruto.max_tramos}.`
    );
  }

  return {
    origen,
    desde,
    hasta,
    tipo_dte: bruto.tipo_dte,
    folio: bruto.folio,
    folio_hasta: bruto.folio_hasta,
    contraparte,
    rzn_soc: rznSoc,
    max_tramos: bruto.max_tramos,
  };
}

// Mismo criterio que `FechaRequerida` en core/schemas/mipyme.ts: formato
// YYYY-MM-DD Y que exista de verdad en el calendario (un 31 de un mes de 30
// pasa el regex pero no es una fecha real).
function validarFecha(valor: string, etiqueta: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw new Error(`${etiqueta}="${valor}" tiene que tener formato YYYY-MM-DD.`);
  }
  const d = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw new Error(`${etiqueta}="${valor}" no es una fecha que exista en el calendario.`);
  }
}

// El tercer nivel de troceo combina TPO_DOC con FOLIO/FOLIOHASTA o con
// RUT_RECP en la misma llamada, y esa combinación no está verificada
// end-to-end contra el SII (ver RESPALDO_XML_TERCER_NIVEL en ritmoSii.ts). Si
// se pidieron ambos filtros a la vez, esto dice EXPLÍCITAMENTE si el CGI los
// respetó los dos o si ignoró alguno — que es justo lo que hay que confirmar
// antes de prender el flag. `null` cuando el chequeo no tiene con qué
// confirmarse (el XML no trae el campo), no `true`: antes un SetDTE vacío
// contaba como "respetado" sin haber verificado nada.
export function calcularVeredictoTercerNivel(
  origen: 'emitidos' | 'recibidos',
  xml: string,
  filtros: Pick<FiltrosNormalizados, 'tipo_dte' | 'folio' | 'folio_hasta' | 'contraparte'>
): string | null {
  const tipoPedido = filtros.tipo_dte;
  if (tipoPedido == null || (filtros.folio == null && filtros.contraparte == null)) return null;

  const tipos = [...new Set([...xml.matchAll(/<TipoDTE>(.*?)<\/TipoDTE>/g)].map(m => m[1]))];
  const folios = [...new Set([...xml.matchAll(/<Folio>(.*?)<\/Folio>/g)].map(m => m[1]))];
  const emisores = [...new Set([...xml.matchAll(/<RUTEmisor>(.*?)<\/RUTEmisor>/g)].map(m => m[1]))];
  const receptores = [...new Set([...xml.matchAll(/<RUTRecep>(.*?)<\/RUTRecep>/g)].map(m => m[1]))];

  const tipoOk: boolean | null =
    tipos.length === 0 ? null : tipos.length === 1 && tipos[0] === String(tipoPedido);

  const folioDesde = filtros.folio;
  const folioHasta = filtros.folio_hasta ?? folioDesde;
  const folioOk: boolean | null | 'n/a' = folioDesde == null
    ? 'n/a'
    : folios.length === 0
      ? null
      : folios.every(f => Number(f) >= folioDesde && Number(f) <= (folioHasta as number));

  const cuerpoContraparte = filtros.contraparte ? soloCuerpoRut(filtros.contraparte) : undefined;
  const listaContraparte = origen === 'emitidos' ? receptores : emisores;
  const contraparteOk: boolean | null | 'n/a' = !cuerpoContraparte
    ? 'n/a'
    : listaContraparte.length === 0
      ? null
      : listaContraparte.every(r => soloCuerpoRut(r) === cuerpoContraparte);

  const inconcluyentes: string[] = [];
  if (tipoOk === null) inconcluyentes.push('no trae <TipoDTE>');
  if (folioOk === null) inconcluyentes.push('no trae <Folio>');
  if (contraparteOk === null) inconcluyentes.push('no trae <RUTRecep>/<RUTEmisor>');

  if (inconcluyentes.length > 0) {
    return `NO CONCLUYENTE — el XML ${inconcluyentes.join(' y ')}, no se puede confirmar si el filtro se respetó`
      + ` (tipo=${tipoOk}, folio=${folioOk}, contraparte=${contraparteOk})`;
  }
  const respetado = tipoOk === true && (folioOk === true || folioOk === 'n/a')
    && (contraparteOk === true || contraparteOk === 'n/a');
  return (respetado ? 'RESPETADO' : 'NO RESPETADO — revisar antes de prender RESPALDO_XML_TERCER_NIVEL')
    + ` (tipo=${tipoOk}, folio=${folioOk}, contraparte=${contraparteOk})`;
}

// --- Modo de una consulta: intacto, vía la ruta REST -----------------------

export async function ejecutarModoUnaConsulta(): Promise<void> {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasMipyme(rutas, registro, credenciales);
  const cred = credencialParaBody(p);

  const filtros = normalizarFiltros({
    origen: process.env.VERIF_ORIGEN,
    desde: process.env.VERIF_DESDE,
    hasta: process.env.VERIF_HASTA,
    tipo_dte: numeroDe('VERIF_TIPO_DTE'),
    folio: numeroDe('VERIF_FOLIO'),
    folio_hasta: numeroDe('VERIF_FOLIO_HASTA'),
    contraparte: process.env.VERIF_CONTRAPARTE,
    rzn_soc: process.env.VERIF_RZN_SOC,
  }, 'VERIF');

  console.log(`Perfil ${NOMBRE}, rango ${filtros.desde}..${filtros.hasta}`);

  const r = await rutas.get('POST /v1/mipyme/respaldo-xml')!({
    ...cred,
    empresa_rut: process.env.VERIF_EMPRESA,
    origen: filtros.origen,
    fecha_desde: filtros.desde,
    fecha_hasta: filtros.hasta,
    contraparte_rut: filtros.contraparte,
    razon_social: filtros.rzn_soc,
    folio_desde: filtros.folio,
    folio_hasta: filtros.folio_hasta,
    tipo_dte: filtros.tipo_dte,
  });
  const b = r.body as Record<string, unknown>;

  if (b.ok !== true) {
    console.log(`FALLA  status=${r.status} error=${b.error} detalle=${String(b.detalle ?? '')}`);
    return;
  }

  const tramos = b.tramos as { nombre_archivo: string; xml: string; documentos: number; fecha_desde: string; fecha_hasta: string }[];
  console.log(`  ${b.documentos} documentos en ${tramos.length} tramo(s)`);

  for (const t of tramos) {
    // Que empiece con la declaración XML es lo que separa un respaldo de una
    // página de error: las dos son texto y las dos se guardan igual.
    const esXml = /^\s*<\?xml/.test(t.xml) && t.xml.includes('<SetDTE');
    console.log(
      `  ${t.fecha_desde}..${t.fecha_hasta}: ${t.documentos} DTE, ${t.xml.length} chars, `
      + `SetDTE: ${esXml ? 'SÍ' : 'NO — ' + t.xml.slice(0, 120)}`);

    // El detalle por ítem es la razón de ser de esta ruta: si viniera un SetDTE
    // sin <Detalle>, el respaldo serviría para archivar pero no para clasificar.
    const detalles = (t.xml.match(/<Detalle>/g) ?? []).length;
    console.log(`    bloques <Detalle>: ${detalles}`);

    // Con qué contrapartes vino el respaldo. Es lo que prueba si un filtro
    // FILTRÓ de verdad: el CGI no da error con un filtro que ignora, devuelve
    // todo — y "todo" se lee igual que "el filtro no aplicaba a nadie".
    const emisores = [...new Set([...t.xml.matchAll(/<RUTEmisor>(.*?)<\/RUTEmisor>/g)].map(m => m[1]))];
    const receptores = [...new Set([...t.xml.matchAll(/<RUTRecep>(.*?)<\/RUTRecep>/g)].map(m => m[1]))];
    const folios = [...new Set([...t.xml.matchAll(/<Folio>(.*?)<\/Folio>/g)].map(m => m[1]))];
    const tipos = [...new Set([...t.xml.matchAll(/<TipoDTE>(.*?)<\/TipoDTE>/g)].map(m => m[1]))];
    console.log(`    emisores: ${emisores.join(', ') || '(ninguno)'}`);
    console.log(`    receptores: ${receptores.join(', ') || '(ninguno)'}`);
    console.log(`    folios: ${folios.slice(0, 8).join(', ')}${folios.length > 8 ? ` (+${folios.length - 8})` : ''}`);
    console.log(`    tipos de documento: ${tipos.join(', ') || '(ninguno)'}`);

    const veredicto = calcularVeredictoTercerNivel(filtros.origen, t.xml, filtros);
    if (veredicto) console.log(`    tipo_dte+folio/contraparte: ${veredicto}`);

    if (SALIDA && esXml) {
      fs.mkdirSync(SALIDA, { recursive: true });
      // El nombre lo arma la ruta y ya viene saneado; el basename va igual
      // porque este valor termina siendo un path real.
      const destino = path.join(SALIDA, path.basename(t.nombre_archivo));
      // El encoding de salida sigue al que DECLARA el XML, no uno fijo: el
      // scraper decodifica según lo que responde el SII, así que escribir
      // siempre latin1 corrompería los acentos de un respaldo que viniera en
      // UTF-8, y encima dejaría un prólogo que miente sobre su propio archivo.
      const utf8 = /encoding=["']utf-?8["']/i.test(t.xml.slice(0, 200));
      fs.writeFileSync(destino, Buffer.from(t.xml, utf8 ? 'utf-8' : 'latin1'));
      console.log(`    guardado en ${destino}`);
    }
  }
}

// --- Modo plan: varias consultas, una sola sesión --------------------------

// Un JSON apuntado por VERIF_PLAN, no otro formato: es la forma que menos se
// aparta del estilo del script (que ya lee todo lo demás de configuración
// plana) y no obliga a inventar un parser de línea de comandos para algo que
// sólo corre a mano o desde un runbook.
export interface ConsultaPlan extends FiltrosCrudos {
  // Puramente para leer el reporte; no participa de la consulta.
  etiqueta?: string;
}

export interface PlanArchivo {
  consultas: ConsultaPlan[];
  // Sobrescribe la pausa entre consultas (ver ritmoSii.pausaConfigurada). Sin
  // esto, `recorrerConRitmo` ya aplica el piso por defecto. Un valor por
  // debajo del piso NO lo salta: `leerPlan` (y, por defensa, `ejecutarPlan`)
  // lo suben al piso — bajarlo no es un ajuste válido ni por archivo.
  pausa_ms?: number;
}

export function leerPlan(rutaJson: string): PlanArchivo {
  const crudo = fs.readFileSync(rutaJson, 'utf-8');
  let json: unknown;
  try {
    json = JSON.parse(crudo);
  } catch (e) {
    throw new Error(`VERIF_PLAN apunta a ${rutaJson}, que no es JSON válido: ${(e as Error).message}`);
  }
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.consultas) || obj.consultas.length === 0) {
    throw new Error(`VERIF_PLAN (${rutaJson}) tiene que traer un array "consultas" con al menos un elemento.`);
  }
  // Mismo criterio que los chequeos de tipo por campo de `normalizarFiltros`:
  // un elemento de "consultas" que no es un objeto (un `null`, un número, un
  // string) revienta más abajo con un error sin contexto —`normalizarFiltros`
  // asume que puede leer `bruto.origen`, `bruto.desde`, etc.— en vez de decir
  // CUÁL consulta del plan está mal formada.
  obj.consultas.forEach((c, i) => {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      throw new Error(
        `VERIF_PLAN (${rutaJson}): consultas[${i}] tiene que ser un objeto; se recibió ${JSON.stringify(c)}.`
      );
    }
  });

  // El PISO de ritmo (`ritmoSii.pausaConfigurada`) tiene el mismo criterio que
  // `RITMO_SII_MS`: el defecto es un piso, no una sugerencia, y no se permite
  // bajarlo. Sin este chequeo, un JSON de plan con `"pausa_ms": 0` reintroduce
  // por archivo exactamente el atajo que la variable de entorno tiene
  // cerrado — y `recorrerConRitmo` sólo aplica el piso cuando `pausaMs` es
  // `undefined`; un `pausaMs` explícito, aunque sea 0, lo pisa por diseño.
  let pausaMs = typeof obj.pausa_ms === 'number' ? obj.pausa_ms : undefined;
  if (pausaMs != null && pausaMs < PAUSA_POR_DEFECTO_MS) {
    console.warn(
      `VERIF_PLAN (${rutaJson}): pausa_ms=${pausaMs} está bajo el piso de ${PAUSA_POR_DEFECTO_MS} ms; ` +
      `se usa el piso. El piso no se puede bajar desde el archivo, igual que RITMO_SII_MS no lo baja por variable de entorno.`
    );
    pausaMs = PAUSA_POR_DEFECTO_MS;
  }

  return {
    consultas: obj.consultas as ConsultaPlan[],
    pausa_ms: pausaMs,
  };
}

export interface TramoConsulta {
  fecha_desde: string;
  fecha_hasta: string;
  documentos: number;
  veredicto_tercer_nivel?: string;
}

export interface ResultadoConsulta {
  ok: boolean;
  error?: string;
  detalle?: string;
  documentos?: number;
  tramos?: TramoConsulta[];
  // Tres estados, no dos: la AUSENCIA de `causa` en una limitación no
  // significa "no topó", significa "no sé" — una limitación sin clasificar
  // puede perfectamente ser un corte por presupuesto de tramos que todavía
  // no se marcó en `mipymeHttp.ts`. Leer esa ausencia como "no topó" afirma
  // comparabilidad que no está confirmada.
  //   'TOPO'           al menos una limitación vino con causa PRESUPUESTO_TRAMOS.
  //   'NO_CLASIFICADO' ninguna topó, pero hay al menos una sin `causa`: no se
  //                    puede afirmar que esta consulta sea comparable con otra.
  //   'NO_TOPO'        sin limitaciones, o todas clasificadas como OTRA.
  comparabilidad?: 'TOPO' | 'NO_TOPO' | 'NO_CLASIFICADO';
}

function comparabilidadDe(
  limitaciones: { causa?: 'PRESUPUESTO_TRAMOS' | 'SII_NO_DISPONIBLE' | 'OTRA' }[]
): 'TOPO' | 'NO_TOPO' | 'NO_CLASIFICADO' {
  if (limitaciones.some(l => l.causa === 'PRESUPUESTO_TRAMOS')) return 'TOPO';
  if (limitaciones.some(l => l.causa === undefined)) return 'NO_CLASIFICADO';
  return 'NO_TOPO';
}

// Lo mínimo que hace falta de un scraper para esta consulta — así un test
// puede pasar un doble sin construir un `MipymeHttpScraper` real.
//
// `limitaciones[].causa` es el discriminador ESTRUCTURADO que el scraper
// devuelve (ver `LimitacionRespaldoXml` en mipymeHttp.ts):
// `'PRESUPUESTO_TRAMOS'` cuando el corte fue por agotar `max_tramos`. Antes esto se
// adivinaba con un regex sobre `motivo` ("necesita más de N tramos"), pero
// ESE texto es una plantilla de prosa que nadie prometió estable — cambiarle
// una palabra (una redacción mejor, una traducción) hacía que la marca
// desapareciera EN SILENCIO y el reporte volviera a mostrar una consulta que
// topó al lado de una que no, sin avisar. Leer el campo es una lectura de
// contrato, no una inferencia sobre prosa.
export interface ScraperRespaldoXml {
  respaldoXml(filtros: {
    empresaRut?: string;
    origen: 'ENV' | 'RCP';
    fechaDesde: string;
    fechaHasta: string;
    tipoDte?: number;
    contraparteRut?: string;
    razonSocial?: string;
    folioDesde?: number;
    folioHasta?: number;
    maxTramos?: number;
  }): Promise<{
    documentos: number;
    tramos: { fechaDesde: string; fechaHasta: string; documentos: number; xml: string }[];
    limitaciones: {
      fechaDesde: string; fechaHasta: string; motivo: string;
      causa?: 'PRESUPUESTO_TRAMOS' | 'SII_NO_DISPONIBLE' | 'OTRA';
    }[];
  }>;
}

// Una consulta, corrida sobre la sesión que le pasen. NO abre sesión propia:
// `ejecutor` decide qué sesión usar, y en el modo plan es SIEMPRE la misma
// instancia para las N consultas — es el punto entero de este modo.
export async function consultarRespaldoXml<T>(
  ejecutor: EjecutorSesion<T>,
  rut: string,
  crearScraper: (sesion: T) => ScraperRespaldoXml,
  empresaRut: string | undefined,
  filtros: FiltrosNormalizados
): Promise<ResultadoConsulta> {
  try {
    const r = await ejecutor.ejecutar(rut, async sesion => crearScraper(sesion).respaldoXml({
      empresaRut,
      origen: filtros.origen === 'emitidos' ? 'ENV' : 'RCP',
      fechaDesde: filtros.desde,
      fechaHasta: filtros.hasta,
      tipoDte: filtros.tipo_dte,
      contraparteRut: filtros.contraparte,
      razonSocial: filtros.rzn_soc,
      folioDesde: filtros.folio,
      folioHasta: filtros.folio_hasta,
      maxTramos: filtros.max_tramos,
    }));

    const comparabilidad = comparabilidadDe(r.limitaciones);

    // Mismo criterio que la ruta REST (ver rest/rutas/mipyme.ts): si NO se
    // bajó NADA y hubo limitaciones, es una FALLA — un `ok:true` con
    // `tramos:[]` se leería igual que "el período no tuvo documentos".
    if (r.tramos.length === 0 && r.limitaciones.length > 0) {
      return {
        ok: false,
        error: 'LIMITE_CONOCIDO',
        detalle: r.limitaciones.map(l => `${l.fechaDesde}..${l.fechaHasta}: ${l.motivo}`).join(' | '),
        comparabilidad,
      };
    }

    return {
      ok: true,
      documentos: r.documentos,
      tramos: r.tramos.map(t => ({
        fecha_desde: t.fechaDesde,
        fecha_hasta: t.fechaHasta,
        documentos: t.documentos,
        veredicto_tercer_nivel: calcularVeredictoTercerNivel(filtros.origen, t.xml, filtros) ?? undefined,
      })),
      comparabilidad,
    };
  } catch (e) {
    // Una consulta que falla NO puede tumbar el resto del plan: el valor del
    // plan es justamente ver TODAS las consultas juntas, incluidas las que
    // fallaron.
    return { ok: false, error: 'ERROR', detalle: (e as Error).message };
  }
}

export interface ResultadoPlanItem {
  indice: number;
  // Lo que traía la consulta CRUDA en el plan, tal cual — se conserva aunque
  // la validación falle, para que el reporte pueda mostrar qué se pidió.
  filtrosCrudos: ConsultaPlan;
  // Ausente cuando la consulta era inválida (no se llegó a normalizar, y
  // mucho menos a correr). Rellenar esto con los DEFAULTS de una consulta
  // vacía (como se hacía antes) mentía en el reporte: una consulta con
  // `origen` mal escrito se leía como "recibidos, mes pasado", como si
  // hubiera sido eso lo que se pidió.
  filtros?: FiltrosNormalizados;
  resultado: ResultadoConsulta;
}

// Recorre el plan CON la pausa que ya existe para barridos (`ritmoSii.ts`), no
// una inventada acá: `recorrerConRitmo` ya respeta el piso de 1200 ms y avisa
// si alguien intenta bajarlo por env — reusarlo es lo que evita que el modo
// plan tenga su propio riesgo de bloqueo.
//
// `opciones.pausaMsSinPiso` es la ÚNICA forma de mandarle a
// `recorrerConRitmo` una pausa por debajo del piso, y sólo la usan los tests
// (el nombre lo dice, y no es parte de `PlanArchivo`/`leerPlan`, que es la
// forma que entra por archivo real). `plan.pausa_ms` en cambio SIEMPRE se
// sube al piso acá, aunque `leerPlan` ya lo suba al leer el JSON: alguien
// podría construir un `PlanArchivo` a mano (sin pasar por `leerPlan`) y
// mandarlo igual con `pausa_ms: 0` — `recorrerConRitmo` sólo aplica su piso
// cuando `pausaMs` es `undefined`, así que un `pausaMs` explícito, aunque sea
// 0, lo pisa por diseño, y sin este segundo chequeo el atajo reaparecería acá.
//
// `opciones.onResultado` SÍ es de producción: `ejecutarModoPlan` lo usa para
// acumular cada resultado A MEDIDA que se produce, no sólo al final. Cada
// consulta individual ya está protegida por el `try/catch` de acá abajo, así
// que en la práctica esto nunca hace falta para una falla de negocio — pero
// si `recorrerConRitmo` (o algo fuera de este `try`) llegara a lanzar a mitad
// de un plan largo, sin este acumulador el llamador perdería TODAS las
// consultas ya resueltas, no sólo la que falló.
export async function ejecutarPlan<T>(
  plan: PlanArchivo,
  ejecutor: EjecutorSesion<T>,
  rut: string,
  crearScraper: (sesion: T) => ScraperRespaldoXml,
  empresaRut: string | undefined,
  opciones?: { pausaMsSinPiso?: number; onResultado?: (item: ResultadoPlanItem) => void }
): Promise<ResultadoPlanItem[]> {
  const pausaMs = opciones?.pausaMsSinPiso !== undefined
    ? opciones.pausaMsSinPiso
    : (plan.pausa_ms != null ? Math.max(plan.pausa_ms, PAUSA_POR_DEFECTO_MS) : undefined);

  return recorrerConRitmo(
    plan.consultas,
    async (consultaBruta, indice) => {
      let item: ResultadoPlanItem;
      try {
        const filtros = normalizarFiltros(consultaBruta, `consultas[${indice}]`);
        const resultado = await consultarRespaldoXml(ejecutor, rut, crearScraper, empresaRut, filtros);
        item = { indice, filtrosCrudos: consultaBruta, filtros, resultado };
      } catch (e) {
        // Sólo cae acá un error de VALIDACIÓN (por ejemplo un origen mal
        // escrito): consultarRespaldoXml ya atrapa los errores de la consulta
        // en sí. Sin este catch, una consulta inválida en la posición 2 de 3
        // abortaría el `recorrerConRitmo` entero (no atrapa nada por dentro) y
        // se perdería la 3.
        item = {
          indice,
          filtrosCrudos: consultaBruta,
          resultado: { ok: false, error: 'ERROR', detalle: (e as Error).message },
        };
      }
      opciones?.onResultado?.(item);
      return item;
    },
    { pausaMs }
  );
}

function describirFiltros(f: FiltrosNormalizados): string {
  const partes = [`origen=${f.origen}`, `rango=${f.desde}..${f.hasta}`];
  if (f.tipo_dte != null) partes.push(`tipo_dte=${f.tipo_dte}`);
  if (f.folio != null) partes.push(`folio=${f.folio}${f.folio_hasta != null ? `-${f.folio_hasta}` : ''}`);
  if (f.contraparte) partes.push(`contraparte=${f.contraparte}`);
  if (f.rzn_soc) partes.push(`rzn_soc="${f.rzn_soc}"`);
  if (f.max_tramos != null) partes.push(`max_tramos=${f.max_tramos}`);
  return partes.join(' ');
}

// Un solo archivo, legible, en el orden en que se ejecutaron las consultas —
// es lo que permite COMPARAR: hoy el script sólo da un veredicto por corrida,
// y el valor de un plan está en ver las consultas juntas.
export function armarReporte(
  plan: PlanArchivo,
  resultados: ResultadoPlanItem[],
  construccionesDeContexto: number
): string {
  const lineas: string[] = [];
  lineas.push('=== Verificación de respaldo XML — plan de consultas ===');
  lineas.push('');

  // La contaminación tiene que ser IMPOSIBLE de no ver: es lo que impidió
  // darse cuenta la vez pasada, cuando quince corridas sueltas (quince
  // logins) dieron 3 documentos contra 7 para el mismo mes y tipo de
  // documento, sin ninguna página de error de por medio. Cada contexto
  // construido es un login nuevo al SII: contarlos es contar logins.
  if (construccionesDeContexto > 1) {
    lineas.push(`ATENCIÓN: esta corrida abrió ${construccionesDeContexto} CONTEXTOS (logins) al SII, no uno solo.`);
    lineas.push('Una verificación con varios logins NO es comparable consigo misma:');
    lineas.push('cada login abre una sesión nueva del portal, y no hay garantía de');
    lineas.push('que dos sesiones del mismo RUT devuelvan lo mismo para el mismo');
    lineas.push('pedido. No saques conclusiones de este reporte.');
  } else {
    lineas.push(`Contextos (logins) abiertos en esta corrida: ${construccionesDeContexto} (una sola sesión para todo el plan).`);
  }
  lineas.push('');

  resultados.forEach(({ indice, filtros, filtrosCrudos, resultado }) => {
    lineas.push(`--- Consulta ${indice + 1}/${plan.consultas.length} ---`);
    if (filtrosCrudos.etiqueta) lineas.push(`  etiqueta: ${filtrosCrudos.etiqueta}`);
    if (filtros) {
      lineas.push(`  ${describirFiltros(filtros)}`);
    } else {
      // La consulta ni siquiera se pudo normalizar (filtro inválido): se
      // muestra tal cual vino, NADA de rellenar con los defaults de una
      // consulta vacía — eso mentiría sobre qué se pidió.
      lineas.push(`  INVÁLIDA, tal como vino: ${JSON.stringify(filtrosCrudos)}`);
    }
    if (!resultado.ok) {
      lineas.push(`  FALLA  error=${resultado.error} detalle=${resultado.detalle ?? ''}`);
      return;
    }
    // Marcado ACÁ y no sólo en el detalle de una limitación: una consulta que
    // topó max_tramos puede seguir siendo ok:true con un respaldo PARCIAL, y
    // comparar sus documentos contra los de una consulta que no topó es
    // exactamente la comparación no comparable que este modo vino a evitar.
    // El tercer estado (NO_CLASIFICADO) existe porque la ausencia de `causa`
    // en una limitación significa "no sé", no "no topó": afirmar
    // comparabilidad ahí sería afirmar de más.
    let marca: string | undefined;
    if (resultado.comparabilidad === 'TOPO') {
      marca = '  ⚠ TOPÓ max_tramos — respaldo PARCIAL, NO comparable con una consulta que no topó';
    } else if (resultado.comparabilidad === 'NO_CLASIFICADO') {
      marca = '  ⚠ NO CLASIFICADO — hay limitaciones sin `causa`; no se puede afirmar que esta '
        + 'consulta sea comparable con otra';
    }
    lineas.push(`  ${resultado.documentos} documentos en ${resultado.tramos?.length ?? 0} tramo(s)`);
    if (marca) lineas.push(marca);
    for (const t of resultado.tramos ?? []) {
      lineas.push(`    ${t.fecha_desde}..${t.fecha_hasta}: ${t.documentos} DTE`
        + (t.veredicto_tercer_nivel ? ` — ${t.veredicto_tercer_nivel}` : ''));
    }
  });

  return lineas.join('\n') + '\n';
}

// Arma el registro contando cuántas veces se CONSTRUYÓ un `Browser` — no
// cuántos logins hizo el SII, que el registro nunca reporta. Que un contexto
// nuevo implique un login nuevo es una propiedad de `registroSesionesSii.ts`
// (un contexto = una sesión autenticada), no algo que este contador verifique
// por su cuenta; de ahí el nombre. No hace falta tocar `registroSesionesSii.ts`
// para esto: `crearRegistroSesionesSii` ya recibe la factory de `Browser` como
// parámetro inyectable, y contar ahí es contar construcciones sin adivinar por
// otro lado.
export function crearEjecutorDeUnaSesion(
  credenciales: ProveedorCredencialesRuntime
): { registro: RegistroSesiones<SessionManager>; contarConstruccionesDeContexto: () => number } {
  let construcciones = 0;
  const registro = crearRegistroSesionesSii(credenciales, id => { construcciones += 1; return new Browser(id); });
  return { registro, contarConstruccionesDeContexto: () => construcciones };
}

export async function ejecutarModoPlan(rutaPlan: string): Promise<void> {
  // El chequeo de VERIF_SALIDA va ANTES de leer el plan: si falta, no tiene
  // sentido pagar la lectura del archivo (ni, con ella, el aviso de
  // `leerPlan` si el `pausa_ms` del archivo estaba bajo el piso) por un plan
  // que no se va a correr — el operador vería un aviso sobre algo que nunca
  // pasó.
  if (!SALIDA) {
    throw new Error(
      'VERIF_SALIDA es obligatorio en modo plan: ahí queda el reporte comparable ' +
      'de todas las consultas — sin un archivo no hay dónde comparar.'
    );
  }
  const plan = leerPlan(rutaPlan);

  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'clave') {
    credenciales.guardar(p.rut, p.credencial.clave);
  } else {
    credenciales.guardarCertificado(
      p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  }

  const { registro, contarConstruccionesDeContexto } = crearEjecutorDeUnaSesion(credenciales);
  const empresaRut = process.env.VERIF_EMPRESA;

  console.log(`Plan de ${plan.consultas.length} consulta(s), perfil ${NOMBRE}, UNA sola sesión`);

  // Acumulador de resultados A MEDIDA que se producen, no sólo al final: cada
  // consulta individual ya está protegida por su propio try/catch dentro de
  // `ejecutarPlan`, así que en la práctica esto no hace falta para una falla
  // de negocio — pero si algo ajeno a una consulta puntual hiciera que
  // `ejecutarPlan` lance (por ejemplo, un plan de quince consultas donde algo
  // revienta a mitad de camino), sin este acumulador se perderían TODAS las
  // mediciones ya resueltas, no sólo la que falló.
  let resultados: ResultadoPlanItem[] = [];
  let errorFatal: Error | undefined;
  try {
    resultados = await ejecutarPlan(
      plan,
      registro,
      p.rut,
      sesion => new MipymeHttpScraper(new SiiHttpClient(sesion), sesion),
      empresaRut,
      { onResultado: item => { resultados.push(item); } }
    );
  } catch (e) {
    errorFatal = e as Error;
  } finally {
    // Cierra la sesión compartida al terminar el plan: sin esto el proceso
    // deja un Browser vivo y, peor, la sesión del SII abierta hasta que
    // expire sola (ver registroSesionesSii.ts sobre por qué eso importa).
    //
    // El `cerrar` que recibe `cerrarYOlvidar` es un NO-OP a propósito: el
    // `destruir` que `crearRegistroSesionesSii` ya le inyectó al registro es
    // `cerrarSesionSii`, que hace `logout()` Y `cerrarContexto()` — y lo hace
    // con cada paso en su propio try/catch, así que un logout que falla no
    // tapa el resultado del plan. Pasar OTRO `sesion.logout()` acá duplicaría
    // el logout (uno sin protección, el de adentro protegido) y, peor, si
    // ESE logout desprotegido lanza, `cerrarYOlvidar` lo propaga desde su
    // `finally` interno y se pierde el error real del plan.
    //
    // El borrado de la credencial va en su PROPIO `finally` anidado: si
    // `cerrarYOlvidar` lanzara (por ejemplo porque el `sesionDe` de adentro
    // reventó antes de terminar), sin este anidamiento la línea de abajo
    // nunca correría y el `.pfx` de un certificado real (perfil por defecto
    // de este script) quedaría en disco con ruta predecible.
    try {
      await registro.cerrarYOlvidar(p.rut, async () => {});
    } finally {
      credenciales.borrar(p.rut);
    }
  }

  const construccionesDeContexto = contarConstruccionesDeContexto();
  let reporte = armarReporte(plan, resultados, construccionesDeContexto);
  // Si `ejecutarPlan` lanzó, el reporte de arriba es PARCIAL (sólo las
  // consultas que llegaron a resolverse antes del corte) — se escribe IGUAL,
  // en vez de perder mediciones que ya costaron llamadas reales al portal, y
  // se avisa explícitamente para que no se lea como una corrida completa.
  if (errorFatal) {
    reporte += `\nATENCIÓN: el plan se interrumpió antes de terminar (${resultados.length}/`
      + `${plan.consultas.length} consultas resueltas). Este reporte es PARCIAL.\n`
      + `Error: ${errorFatal.message}\n`;
  }

  fs.mkdirSync(SALIDA, { recursive: true });
  const destino = path.join(SALIDA, 'reporte-verificacion-plan.txt');
  fs.writeFileSync(destino, reporte, 'utf-8');
  console.log(reporte);
  console.log(`Reporte escrito en ${destino}`);

  if (errorFatal) throw errorFatal;
}

async function main(): Promise<void> {
  if (process.env.VERIF_PLAN) {
    await ejecutarModoPlan(process.env.VERIF_PLAN);
  } else {
    await ejecutarModoUnaConsulta();
  }
}

// Guardia para que importar este módulo desde un test no dispare `main()`
// (que abre sesiones reales y lee variables de entorno de producción).
// `ts-node src/scripts/verificarRespaldoXml.ts` sigue siendo el entry point y
// sigue corriendo `main()` igual que antes.
if (require.main === module) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
