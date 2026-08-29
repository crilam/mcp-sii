import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMisii } from '../rest/rutas/misii';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';

// Verifica `/v1/misii/datos-contribuyente` contra el SII real por el handler
// REST. Se imprime la ficha sin el detalle de direcciones ni correos: es la de
// un contribuyente real.
const NOMBRE = (process.argv[2] ?? 'mercado') as NombrePerfil;

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasMisii(rutas, registro, credenciales);

  const r = await rutas.get('POST /v1/misii/datos-contribuyente')!(credencialParaBody(p));
  const b = r.body as Record<string, unknown>;
  if (b.ok !== true) {
    console.log(`FALLA status=${r.status} error=${b.error} detalle=${String(b.detalle ?? '').slice(0, 200)}`);
    return;
  }
  const { direcciones, atributos, alertas, email, telefonoMovil, ...resto } = b as Record<string, unknown> & {
    direcciones: unknown[]; atributos: { codigo: string; descripcion: string; desde: string }[]; alertas: unknown[];
  };
  void email; void telefonoMovil;
  console.log(JSON.stringify(resto, null, 1));
  console.log(`direcciones: ${direcciones.length}, alertas: ${alertas.length}, atributos: ${atributos.length}`);
  for (const a of atributos) console.log(`  ${a.codigo.padEnd(6)} ${a.descripcion.slice(0, 50).padEnd(52)} desde ${a.desde}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
