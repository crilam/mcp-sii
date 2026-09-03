import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';

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
const NOMBRE = (process.argv[2] ?? 'certificado') as NombrePerfil;
const SALIDA = process.env.VERIF_SALIDA;

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

  const r = await rutas.get('POST /v1/mipyme/respaldo-xml')!({
    ...cred,
    empresa_rut: process.env.VERIF_EMPRESA,
    origen: process.env.VERIF_ORIGEN ?? 'recibidos',
    fecha_desde: desde,
    fecha_hasta: hasta,
    contraparte_rut: process.env.VERIF_CONTRAPARTE,
    razon_social: process.env.VERIF_RZN_SOC,
    folio_desde: process.env.VERIF_FOLIO ? Number(process.env.VERIF_FOLIO) : undefined,
    folio_hasta: process.env.VERIF_FOLIO_HASTA ? Number(process.env.VERIF_FOLIO_HASTA) : undefined,
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
    console.log(`    emisores: ${emisores.join(', ') || '(ninguno)'}`);
    console.log(`    receptores: ${receptores.join(', ') || '(ninguno)'}`);
    console.log(`    folios: ${folios.slice(0, 8).join(', ')}${folios.length > 8 ? ` (+${folios.length - 8})` : ''}`);

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
