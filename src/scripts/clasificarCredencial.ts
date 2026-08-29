import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { registrarRutasRcv } from '../rest/rutas/rcv';
import { registrarRutasBhe } from '../rest/rutas/bhe';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, perfilesDisponibles, descripcion, NombrePerfil, PERFILES } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// ¿Para qué sirve realmente esta credencial?
//
// La ronda 2 se descubrió bloqueada recién al relevar el portal: el RUT cargado
// no estaba inscrito en Facturación Gratuita, y eso no se ve en el .env ni en
// ninguna parte hasta que el selector de empresas vuelve vacío. Este script hace
// esa pregunta ANTES de empezar una ronda.
//
// Cada sonda es la ruta REST de producción, no el scraper: lo que interesa es si
// el servicio puede responder con esta credencial, no si el parser anda.
//
// Va con ritmo: son pocas llamadas, pero el SII cuenta por patrón de uso.
const PERIODO = process.env.CLASIF_PERIODO ?? '202506';

interface Sonda {
  nombre: string;
  ruta: string;
  body: (cred: Record<string, string>) => Record<string, unknown>;
  // Qué significa que esta sonda traiga datos. No es "anda o no anda": una
  // credencial sin BHE puede ser perfectamente válida y no ser persona natural.
  significa: string;
}

const SONDAS: Sonda[] = [
  {
    nombre: 'mipyme',
    ruta: 'POST /v1/mipyme/list-empresas',
    body: c => ({ ...c }),
    significa: 'inscrito en Facturación Gratuita; puede relevarse el portal mipyme',
  },
  {
    nombre: 'rcv',
    ruta: 'POST /v1/rcv/resumen',
    body: c => ({ ...c, periodo: PERIODO, operacion: 'VENTA' }),
    significa: 'tiene registro de compras y ventas; sirve para RCV, DTE y F29',
  },
  {
    nombre: 'bhe',
    ruta: 'POST /v1/bhe/resumen',
    body: c => ({ ...c, anio: new Date().getFullYear() - 1 }),
    significa: 'emite o recibe boletas de honorarios; perfil de persona natural',
  },
];

function armarRutas() {
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasMipyme(rutas, registro, credenciales);
  registrarRutasRcv(rutas, registro, credenciales);
  registrarRutasBhe(rutas, registro, credenciales);
  return rutas;
}

async function clasificar(nombre: NombrePerfil) {
  const p = perfil(nombre);
  console.log(`\n${nombre.toUpperCase()}  ${p.rut}`);
  console.log(`  esperado: ${descripcion(nombre)}`);

  const rutas = armarRutas();
  const cred = { rut: p.rut, clave: p.clave };

  for (const sonda of SONDAS) {
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const handler = rutas.get(sonda.ruta);
    if (!handler) {
      console.log(`  ${sonda.nombre.padEnd(8)} SIN RUTA  ${sonda.ruta}`);
      continue;
    }
    try {
      const r = await handler(sonda.body(cred));
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (b.ok === true) {
        console.log(`  ${sonda.nombre.padEnd(8)} SÍ    ${sonda.significa}`);
      } else {
        console.log(
          `  ${sonda.nombre.padEnd(8)} no    ${b.error} — `
          + `${String(b.detalle ?? '').slice(0, 80)}`);
      }
    } catch (e) {
      console.log(`  ${sonda.nombre.padEnd(8)} error ${(e as Error).message.slice(0, 80)}`);
    }
  }
}

async function main() {
  const pedidos = process.argv.slice(2) as NombrePerfil[];
  const disponibles = perfilesDisponibles();
  const correr = pedidos.length > 0 ? pedidos : disponibles;

  if (correr.length === 0) {
    console.log(
      'No hay ningún perfil cargado en el .env.\n'
      + `Hacen falta tres: ${PERFILES.join(', ')}. Ver .env.example.`);
    return;
  }

  const faltantes = PERFILES.filter(n => !disponibles.includes(n));
  if (faltantes.length > 0) {
    console.log(`Sin cargar todavía: ${faltantes.join(', ')}.`);
  }

  for (const nombre of correr) await clasificar(nombre);
  console.log('');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
