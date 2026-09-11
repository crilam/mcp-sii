import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { RegistroSesiones, EjecutorSesion } from '../registroSesiones';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';
import { soloCuerpoRut, MipymeHttpScraper } from '../scrapers/mipymeHttp';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { Browser } from '../browser';
import { recorrerConRitmo } from '../ritmoSii';

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
}

// Normalizado ACÁ, no leído crudo en cada punto que lo necesita: la ruta
// REST trata cualquier valor que no sea EXACTAMENTE `'emitidos'` como
// recibidos (`origen === 'emitidos' ? 'ENV' : 'RCP'`), así que un origen con
// mayúsculas, un typo, o el nombre interno `'ENV'` ejecutaría recibidos EN
// SILENCIO mientras quien corre el script cree haber pedido emitidos. Con un
// solo punto de normalización, tanto el modo de una consulta como cada
// consulta del plan quedan protegidos igual.
export function normalizarFiltros(bruto: FiltrosCrudos, etiquetaOrigen: string): FiltrosNormalizados {
  const rango = mesPasado();
  const origenCrudo = (bruto.origen ?? 'recibidos').toLowerCase();
  if (origenCrudo !== 'emitidos' && origenCrudo !== 'recibidos') {
    throw new Error(
      `${etiquetaOrigen}="${bruto.origen}" no es válido: sólo "emitidos" o "recibidos" ` +
      `(la ruta REST trata cualquier otro valor como "recibidos" en silencio, y este script no lo repite).`
    );
  }
  return {
    origen: origenCrudo as 'emitidos' | 'recibidos',
    desde: bruto.desde ?? rango.desde,
    hasta: bruto.hasta ?? rango.hasta,
    tipo_dte: bruto.tipo_dte,
    folio: bruto.folio,
    folio_hasta: bruto.folio_hasta,
    contraparte: bruto.contraparte,
    rzn_soc: bruto.rzn_soc,
  };
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
  }, 'VERIF_ORIGEN');

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
  // esto, `recorrerConRitmo` ya aplica el piso de 1200 ms por defecto.
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
  return {
    consultas: obj.consultas as ConsultaPlan[],
    pausa_ms: typeof obj.pausa_ms === 'number' ? obj.pausa_ms : undefined,
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
}

// Lo mínimo que hace falta de un scraper para esta consulta — así un test
// puede pasar un doble sin construir un `MipymeHttpScraper` real.
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
  }): Promise<{
    documentos: number;
    tramos: { fechaDesde: string; fechaHasta: string; documentos: number; xml: string }[];
    limitaciones: { fechaDesde: string; fechaHasta: string; motivo: string }[];
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
    }));

    // Mismo criterio que la ruta REST (ver rest/rutas/mipyme.ts): si NO se
    // bajó NADA y hubo limitaciones, es una FALLA — un `ok:true` con
    // `tramos:[]` se leería igual que "el período no tuvo documentos".
    if (r.tramos.length === 0 && r.limitaciones.length > 0) {
      return {
        ok: false,
        error: 'LIMITE_CONOCIDO',
        detalle: r.limitaciones.map(l => `${l.fechaDesde}..${l.fechaHasta}: ${l.motivo}`).join(' | '),
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
  filtros: FiltrosNormalizados;
  resultado: ResultadoConsulta;
}

// Recorre el plan CON la pausa que ya existe para barridos (`ritmoSii.ts`), no
// una inventada acá: `recorrerConRitmo` ya respeta el piso de 1200 ms y avisa
// si alguien intenta bajarlo por env — reusarlo es lo que evita que el modo
// plan tenga su propio riesgo de bloqueo.
export async function ejecutarPlan<T>(
  plan: PlanArchivo,
  ejecutor: EjecutorSesion<T>,
  rut: string,
  crearScraper: (sesion: T) => ScraperRespaldoXml,
  empresaRut: string | undefined
): Promise<ResultadoPlanItem[]> {
  return recorrerConRitmo(
    plan.consultas,
    async (consultaBruta, indice) => {
      try {
        const filtros = normalizarFiltros(consultaBruta, `consultas[${indice}].origen`);
        const resultado = await consultarRespaldoXml(ejecutor, rut, crearScraper, empresaRut, filtros);
        return { indice, filtros, resultado };
      } catch (e) {
        // Sólo cae acá un error de VALIDACIÓN (por ejemplo un origen mal
        // escrito): consultarRespaldoXml ya atrapa los errores de la consulta
        // en sí. Sin este catch, un origen inválido en la consulta 2 de 3
        // abortaría el `recorrerConRitmo` entero (no atrapa nada por dentro) y
        // se perdería la 3.
        return {
          indice,
          filtros: normalizarFiltros({}, `consultas[${indice}].origen`),
          resultado: { ok: false, error: 'ERROR', detalle: (e as Error).message },
        };
      }
    },
    { pausaMs: plan.pausa_ms }
  );
}

function describirFiltros(f: FiltrosNormalizados): string {
  const partes = [`origen=${f.origen}`, `rango=${f.desde}..${f.hasta}`];
  if (f.tipo_dte != null) partes.push(`tipo_dte=${f.tipo_dte}`);
  if (f.folio != null) partes.push(`folio=${f.folio}${f.folio_hasta != null ? `-${f.folio_hasta}` : ''}`);
  if (f.contraparte) partes.push(`contraparte=${f.contraparte}`);
  return partes.join(' ');
}

// Un solo archivo, legible, en el orden en que se ejecutaron las consultas —
// es lo que permite COMPARAR: hoy el script sólo da un veredicto por corrida,
// y el valor de un plan está en ver las consultas juntas.
export function armarReporte(plan: PlanArchivo, resultados: ResultadoPlanItem[], logins: number): string {
  const lineas: string[] = [];
  lineas.push('=== Verificación de respaldo XML — plan de consultas ===');
  lineas.push('');

  // La contaminación tiene que ser IMPOSIBLE de no ver: es lo que impidió
  // darse cuenta la vez pasada, cuando quince corridas sueltas (quince
  // logins) dieron 3 documentos contra 7 para el mismo mes y tipo de
  // documento, sin ninguna página de error de por medio.
  if (logins > 1) {
    lineas.push(`ATENCIÓN: esta corrida hizo ${logins} LOGINS al SII, no uno solo.`);
    lineas.push('Una verificación con varios logins NO es comparable consigo misma:');
    lineas.push('cada login abre una sesión nueva del portal, y no hay garantía de');
    lineas.push('que dos sesiones del mismo RUT devuelvan lo mismo para el mismo');
    lineas.push('pedido. No saques conclusiones de este reporte.');
  } else {
    lineas.push(`Logins al SII en esta corrida: ${logins} (una sola sesión para todo el plan).`);
  }
  lineas.push('');

  resultados.forEach(({ indice, filtros, resultado }) => {
    lineas.push(`--- Consulta ${indice + 1}/${plan.consultas.length} ---`);
    lineas.push(`  ${describirFiltros(filtros)}`);
    if (!resultado.ok) {
      lineas.push(`  FALLA  error=${resultado.error} detalle=${resultado.detalle ?? ''}`);
      return;
    }
    lineas.push(`  ${resultado.documentos} documentos en ${resultado.tramos?.length ?? 0} tramo(s)`);
    for (const t of resultado.tramos ?? []) {
      lineas.push(`    ${t.fecha_desde}..${t.fecha_hasta}: ${t.documentos} DTE`
        + (t.veredicto_tercer_nivel ? ` — ${t.veredicto_tercer_nivel}` : ''));
    }
  });

  return lineas.join('\n') + '\n';
}

// Arma el registro contando cuántas veces se construyó un `Browser` — o sea,
// cuántos contextos (logins) nuevos abrió esta corrida. No hace falta tocar
// `registroSesionesSii.ts` para esto: `crearRegistroSesionesSii` ya recibe la
// factory de `Browser` como parámetro inyectable, y contar ahí es exactamente
// contar logins sin adivinar por otro lado.
export function crearEjecutorDeUnaSesion(
  credenciales: ProveedorCredencialesRuntime
): { registro: RegistroSesiones<SessionManager>; contarLogins: () => number } {
  let logins = 0;
  const registro = crearRegistroSesionesSii(credenciales, id => { logins += 1; return new Browser(id); });
  return { registro, contarLogins: () => logins };
}

async function ejecutarModoPlan(rutaPlan: string): Promise<void> {
  const plan = leerPlan(rutaPlan);
  if (!SALIDA) {
    throw new Error(
      'VERIF_SALIDA es obligatorio en modo plan: ahí queda el reporte comparable ' +
      'de todas las consultas — sin un archivo no hay dónde comparar.'
    );
  }

  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'clave') {
    credenciales.guardar(p.rut, p.credencial.clave);
  } else {
    credenciales.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword);
  }

  const { registro, contarLogins } = crearEjecutorDeUnaSesion(credenciales);
  const empresaRut = process.env.VERIF_EMPRESA;

  console.log(`Plan de ${plan.consultas.length} consulta(s), perfil ${NOMBRE}, UNA sola sesión`);

  let resultados: ResultadoPlanItem[];
  try {
    resultados = await ejecutarPlan(
      plan,
      registro,
      p.rut,
      sesion => new MipymeHttpScraper(new SiiHttpClient(sesion), sesion),
      empresaRut
    );
  } finally {
    // Cierra la sesión compartida al terminar el plan: sin esto el proceso
    // deja un Browser vivo y, peor, la sesión del SII abierta hasta que
    // expire sola (ver registroSesionesSii.ts sobre por qué eso importa).
    await registro.cerrarYOlvidar(p.rut, sesion => sesion.logout());
    credenciales.borrar(p.rut);
  }

  const logins = contarLogins();
  const reporte = armarReporte(plan, resultados, logins);

  fs.mkdirSync(SALIDA, { recursive: true });
  const destino = path.join(SALIDA, 'reporte-verificacion-plan.txt');
  fs.writeFileSync(destino, reporte, 'utf-8');
  console.log(reporte);
  console.log(`Reporte escrito en ${destino}`);
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
