import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasRcv } from '../rest/rutas/rcv';
import { RutaHandler } from '../rest/rutas/comun';

// Verificación end-to-end de `/v1/rcv/tipos-documento` atravesando el handler
// REST, que es lo que el criterio de terminado de la ronda 1 exige y quedó
// pendiente: después del barrido del relevamiento, el portal del RCV empezó a
// responder ERROR a todo.
//
// UNA sola llamada, a propósito. El portal quedó sensible y lo último que
// conviene es volver a barrerlo para comprobar si se recuperó: si esta llamada
// falla, se espera más, no se insiste.
async function main() {
  const rut = process.env.SII_RUT;
  const clave = process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_RUT/SII_CLAVE en el entorno.');

  const rutas = new Map<string, RutaHandler>();
  const credenciales = new ProveedorCredencialesRuntime();
  registrarRutasRcv(rutas, crearRegistroSesionesSii(credenciales), credenciales);

  const r = await rutas.get('POST /v1/rcv/tipos-documento')!({ rut, clave });
  const b = r.body as { ok?: boolean; error?: string; datos?: { codigo: number; nombre: string; tipoIngreso: string | null }[] };

  if (b.ok !== true) {
    console.log(`FALLA  status=${r.status} error=${b.error}`);
    console.log('El portal del RCV puede seguir bloqueado. NO insistir: esperar y reintentar más tarde.');
    process.exitCode = 1;
    return;
  }

  const tipos = b.datos ?? [];
  console.log(`ok=true  ${tipos.length} tipo(s) de documento\n`);
  for (const t of tipos.slice(0, 8)) {
    console.log(`   ${String(t.codigo).padStart(3)}  ${(t.nombre ?? '').padEnd(42)} ${t.tipoIngreso ?? '(sin tipo de ingreso)'}`);
  }
  if (tipos.length > 8) console.log(`   ... y ${tipos.length - 8} más`);

  // Lo que hace útil el catálogo: que traiga los códigos que `detalle` pide.
  const conFactura = tipos.some(t => t.codigo === 33);
  const conNotaCredito = tipos.some(t => t.codigo === 61);
  console.log(`\ntrae el 33 (factura electrónica): ${conFactura}`);
  console.log(`trae el 61 (nota de crédito):     ${conNotaCredito}`);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
