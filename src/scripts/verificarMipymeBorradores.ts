import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';

// Verifica `list-borradores` contra el SII real, por el handler REST.
//
// Los borradores no salen del portal viejo sino de otra aplicación con API SDI,
// así que lo primero que hay que confirmar es que la sesión del portal sirve
// para hablarle: el `conversationId` es la cookie TOKEN, y si esa aplicación
// exigiera otra autenticación, esto fallaría acá y no en producción.
const NOMBRE = (process.argv[2] ?? 'certificado') as NombrePerfil;

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasMipyme(rutas, registro, credenciales);

  const cred = credencialParaBody(p);

  // La aplicación de borradores resuelve la empresa por su cuenta, pero desde la
  // sesión del portal: hay que recorrer las empresas seleccionando cada una,
  // porque una lista vacía puede ser "no hay borradores" y no "no funciona".
  const empresas = await rutas.get('POST /v1/mipyme/list-empresas')!({ ...cred });
  const lista = (empresas.body as { datos?: { rut: string; nombre: string }[] }).datos ?? [];

  for (const e of lista) {
    // `list-dte-emitidos` deja la empresa seleccionada como efecto de su propio
    // ciclo: es la forma que hay hoy de fijar la empresa activa sin agregar una
    // ruta que sólo sirva para eso.
    await rutas.get('POST /v1/mipyme/list-dte-emitidos')!({ ...cred, empresa_rut: e.rut });

    const r = await rutas.get('POST /v1/mipyme/list-borradores')!({ ...cred });
    const b = r.body as Record<string, unknown>;

    if (b.ok !== true) {
      console.log(`${e.rut}  FALLA ${b.error}: ${String(b.detalle ?? '').slice(0, 160)}`);
      continue;
    }
    const datos = b.datos as { codigo: string; tipoDte: number | null; campos: object }[];
    console.log(`${e.rut}  ${datos.length} borrador(es)  ${e.nombre.slice(0, 34)}`);
    for (const d of datos.slice(0, 2)) {
      console.log(`    codigo=${d.codigo} tipoDte=${d.tipoDte}`);
      console.log(`    campos: ${Object.keys(d.campos).slice(0, 12).join(', ')}`);
    }
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
