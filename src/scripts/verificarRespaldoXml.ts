import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';
import { soloCuerpoRut } from '../scrapers/mipymeHttp';

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
//   VERIF_SALIDA   directorio donde dejar los XML bajados
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

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasMipyme(rutas, registro, credenciales);
  const cred = credencialParaBody(p);

  const rango = mesPasado();
  const desde = process.env.VERIF_DESDE ?? rango.desde;
  const hasta = process.env.VERIF_HASTA ?? rango.hasta;
  console.log(`Perfil ${NOMBRE}, rango ${desde}..${hasta}`);

  // Normalizado ACÁ, no leído crudo en cada punto que lo necesita: la ruta
  // REST trata cualquier valor que no sea EXACTAMENTE `'emitidos'` como
  // recibidos (`origen === 'emitidos' ? 'ENV' : 'RCP'`), así que un
  // `VERIF_ORIGEN` con mayúsculas, un typo, o el nombre interno `'ENV'`
  // ejecutaría recibidos EN SILENCIO mientras quien corre el script cree
  // haber pedido emitidos. Con un solo valor normalizado y compartido, el
  // chequeo de `contraparteOk` de más abajo no puede leer algo distinto de
  // lo que de verdad se pidió.
  const origenCrudo = (process.env.VERIF_ORIGEN ?? 'recibidos').toLowerCase();
  if (origenCrudo !== 'emitidos' && origenCrudo !== 'recibidos') {
    throw new Error(
      `VERIF_ORIGEN="${process.env.VERIF_ORIGEN}" no es válido: sólo "emitidos" o "recibidos" ` +
      `(la ruta REST trata cualquier otro valor como "recibidos" en silencio, y este script no lo repite).`
    );
  }
  const origen = origenCrudo as 'emitidos' | 'recibidos';

  const r = await rutas.get('POST /v1/mipyme/respaldo-xml')!({
    ...cred,
    empresa_rut: process.env.VERIF_EMPRESA,
    origen,
    fecha_desde: desde,
    fecha_hasta: hasta,
    contraparte_rut: process.env.VERIF_CONTRAPARTE,
    razon_social: process.env.VERIF_RZN_SOC,
    folio_desde: numeroDe('VERIF_FOLIO'),
    folio_hasta: numeroDe('VERIF_FOLIO_HASTA'),
    tipo_dte: numeroDe('VERIF_TIPO_DTE'),
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

    // El tercer nivel de troceo combina TPO_DOC con FOLIO/FOLIOHASTA o con
    // RUT_RECP en la misma llamada, y esa combinación no está verificada
    // contra el SII (ver RESPALDO_XML_TERCER_NIVEL en ritmoSii.ts). Si se
    // pidieron ambos filtros a la vez, este chequeo dice EXPLÍCITAMENTE si el
    // CGI los respetó los dos o si ignoró alguno — que es justo lo que hay
    // que confirmar antes de prender el flag.
    const tipoPedido = process.env.VERIF_TIPO_DTE;
    if (tipoPedido && (process.env.VERIF_FOLIO || process.env.VERIF_CONTRAPARTE)) {
      // `null` (no `true`) cuando el XML no trae ni un `<TipoDTE>`: no es que
      // el filtro se haya respetado, es que este chequeo no tiene con qué
      // confirmarlo. Antes contaba como OK, y un XML sin `<TipoDTE>` (SetDTE
      // vacío, u otro formato) imprimía RESPETADO sin haber verificado nada —
      // justo la evidencia que decide si se prende RESPALDO_XML_TERCER_NIVEL.
      const tipoOk: boolean | null =
        tipos.length === 0 ? null : tipos.length === 1 && tipos[0] === tipoPedido;
      const folioDesde = numeroDe('VERIF_FOLIO');
      const folioHasta = numeroDe('VERIF_FOLIO_HASTA') ?? folioDesde;
      // Mismo tratamiento que `tipoOk`: `every` sobre un arreglo vacío da
      // `true` vacuo, y un XML sin `<Folio>` (SetDTE vacío, u otro formato)
      // imprimía RESPETADO sin haber verificado nada. `null` cuando el
      // filtro SÍ se pidió pero no hay con qué chequearlo.
      //
      // BLOQUEANTE de la ronda 11: `'n/a'`, no `true`, cuando el filtro NI
      // SIQUIERA se pidió. Antes un `true` de "no se pidió folio" y un
      // `true` de "se pidió y el XML lo cumple" se imprimían idénticos —
      // en la salida que decide si prender RESPALDO_XML_TERCER_NIVEL, un
      // "no verifiqué nada" que se lee igual que "verificado" es
      // exactamente el tipo de evidencia que no hay que confundir.
      const folioOk: boolean | null | 'n/a' = folioDesde == null
        ? 'n/a'
        : folios.length === 0
          ? null
          : folios.every(f => Number(f) >= folioDesde && Number(f) <= (folioHasta as number));
      // `soloCuerpoRut`, no `split('-')[0]` a mano: el contrato público de
      // `contraparte_rut` es "con o sin DV", y separar por guión a mano deja
      // pasar un RUT sin DV tal cual en vez de normalizarlo al cuerpo.
      const cuerpoContraparte = process.env.VERIF_CONTRAPARTE
        ? soloCuerpoRut(process.env.VERIF_CONTRAPARTE)
        : undefined;
      const listaContraparte = origen === 'emitidos' ? receptores : emisores;
      // Mismo vacuo que `folioOk`: sin contrapartes en el XML (filtro pedido)
      // no se puede confirmar nada, es `null`, no `true`. Y mismo `'n/a'`
      // que `folioOk` cuando el filtro ni se pidió.
      const contraparteOk: boolean | null | 'n/a' = !cuerpoContraparte
        ? 'n/a'
        : listaContraparte.length === 0
          ? null
          : listaContraparte.every(r => soloCuerpoRut(r) === cuerpoContraparte);
      const inconcluyentes: string[] = [];
      if (tipoOk === null) inconcluyentes.push('no trae <TipoDTE>');
      if (folioOk === null) inconcluyentes.push('no trae <Folio>');
      if (contraparteOk === null) inconcluyentes.push('no trae <RUTRecep>/<RUTEmisor>');
      // `'n/a'` cuenta como respetado a los fines del veredicto (no había
      // nada que violar), pero se imprime distinto de `true` más abajo.
      const veredicto = inconcluyentes.length > 0
        ? `NO CONCLUYENTE — el XML ${inconcluyentes.join(' y ')}, no se puede confirmar si el filtro se respetó`
        : tipoOk === true && (folioOk === true || folioOk === 'n/a')
            && (contraparteOk === true || contraparteOk === 'n/a')
          ? 'RESPETADO'
          : 'NO RESPETADO — revisar antes de prender RESPALDO_XML_TERCER_NIVEL';
      console.log(
        `    tipo_dte+folio/contraparte: ${veredicto}`
        + ` (tipo=${tipoOk}, folio=${folioOk}, contraparte=${contraparteOk})`);
    }

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

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
