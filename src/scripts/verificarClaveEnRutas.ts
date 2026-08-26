import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasRcv } from '../rest/rutas/rcv';
import { registrarRutasDte } from '../rest/rutas/dte';
import { registrarRutasRenta } from '../rest/rutas/renta';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';

// Verifica que las rutas REST aceptan clave tributaria y devuelven datos del
// SII real. Ejercita los HANDLERS de las rutas, no el core: probar el core sólo
// demuestra que el scraper funciona, y lo que cambió acá es el schema de
// credenciales de la ruta — justo la capa que un test del core no toca.
//
// Queda afuera únicamente el transporte HTTP y la auth de tenant, que no
// dependen del SII.
const PERIODO = process.env.VERIF_PERIODO ?? '202506';
const ANIO = Number(process.env.VERIF_ANIO ?? 2025);

function armarRutas(): Map<string, RutaHandler> {
  const rutas = new Map<string, RutaHandler>();
  // Se usa la MISMA factory que restServerIndex.ts, así lo que se verifica es el
  // camino de producción y no una variante parecida. Cuando este script armaba
  // el registro a mano, la copia se desincronizó del original y quedó sin
  // `destruir`: cada consulta dejaba el navegador vivo y el cookie jar en disco.
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  registrarRutasRcv(rutas, registro, credenciales);
  registrarRutasDte(rutas, registro, credenciales);
  registrarRutasRenta(rutas, registro, credenciales);
  registrarRutasMipyme(rutas, registro, credenciales);
  return rutas;
}

async function llamar(rutas: Map<string, RutaHandler>, ruta: string, body: unknown) {
  const handler = rutas.get(ruta);
  if (!handler) {
    console.log(`  SIN RUTA  ${ruta}`);
    return;
  }
  const r = await handler(body);
  const b = (r.body ?? {}) as Record<string, unknown>;
  if (b.ok === true) {
    const datos = Array.isArray(b.datos) ? `datos=${b.datos.length}` : '';
    const filas = Array.isArray(b.filas) ? `filas=${b.filas.length}` : '';
    const decl = Array.isArray(b.declaraciones) ? `declaraciones=${b.declaraciones.length}` : '';
    const extra = [datos, filas, decl, `sinDatos=${b.sinDatos ?? '-'}`, `totalDocs=${b.totalDocumentos ?? '-'}`]
      .filter(Boolean).join(' ');
    console.log(`  ok=true   ${ruta.padEnd(42)} ${extra}`);
  } else {
    console.log(
      `  FALLA     ${ruta.padEnd(42)} status=${r.status} error=${b.error} ` +
      `detalle=${String(b.detalle ?? '').slice(0, 90)}`
    );
  }
}

// El detalle de RCV pasó de 15 a 26 campos: se imprime uno completo para poder
// contrastarlo con el portal, que es la única forma de saber si los campos
// nuevos traen el dato correcto y no sólo "algo".
async function mostrarDetalleCompleto(rutas: Map<string, RutaHandler>, cred: Record<string, string>) {
  const handler = rutas.get('POST /v1/rcv/detalle');
  if (!handler) return;
  const r = await handler({ ...cred, periodo: PERIODO, operacion: 'COMPRA', tipo_doc: 33 });
  const b = r.body as { ok?: boolean; documentos?: Record<string, unknown>[] };
  const doc = b?.documentos?.[0];
  if (!doc) {
    console.log('    (sin documentos en el período para mostrar el detalle completo)');
    return;
  }
  const tot = (b as { totales?: Record<string, unknown> }).totales;
  if (tot) console.log(`    totales: ${JSON.stringify(tot)}`);
  console.log('    detalle completo del primer documento:');
  for (const [k, v] of Object.entries(doc)) {
    console.log(`       ${k.padEnd(30)} ${JSON.stringify(v)}`);
  }
}

async function main() {
  const rut = process.env.SII_RUT;
  const clave = process.env.SII_CLAVE;
  const empresa = process.env.SII_EMPRESA_RUT;
  if (!rut || !clave) throw new Error('Faltan SII_RUT/SII_CLAVE en el entorno.');

  const rutas = armarRutas();
  const cred = { rut, clave };
  console.log(`rut=${rut} empresa=${empresa ?? '(ninguna)'} periodo=${PERIODO} anio=${ANIO}\n`);

  console.log('Con CLAVE (lo que antes daba BAD_REQUEST):');
  await llamar(rutas, 'POST /v1/rcv/resumen', { ...cred, periodo: PERIODO, operacion: 'COMPRA' });
  await llamar(rutas, 'POST /v1/rcv/detalle', { ...cred, periodo: PERIODO, operacion: 'COMPRA', tipo_doc: 33 });
  await mostrarDetalleCompleto(rutas, cred);
  await llamar(rutas, 'POST /v1/dte/list-documentos-recibidos', { ...cred, periodo: PERIODO });
  await llamar(rutas, 'POST /v1/renta/estado-declaracion', { ...cred, anio: ANIO });
  await llamar(rutas, 'POST /v1/mipyme/list-empresas', { ...cred });
  await llamar(rutas, 'POST /v1/rcv/empresas-autorizadas', { ...cred });
  if (empresa) {
    await llamar(rutas, 'POST /v1/rcv/resumen', { ...cred, periodo: PERIODO, operacion: 'COMPRA', empresa_rut: empresa });
  }

  // La emisión NO debe aceptar clave: firmar necesita el certificado. Se espera
  // un 400, y verlo acá es lo que confirma que habilitar las lecturas no abrió
  // un camino a firmar con una credencial más débil.
  console.log('\nEmisión con clave (DEBE rechazarse):');
  await llamar(rutas, 'POST /v1/mipyme/emitir-dte', {
    ...cred, tipo_dte: 33, receptor_rut: '11111111', receptor_dv: '1',
    receptor_razon_social: 'X', receptor_giro: 'X', receptor_direccion: 'X',
    receptor_comuna: 'X', receptor_ciudad: 'X',
    lineas: [{ descripcion: 'X', cantidad: 1, precio_unitario: 1000 }],
  });
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
