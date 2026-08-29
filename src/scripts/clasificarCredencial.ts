import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { registrarRutasRcv } from '../rest/rutas/rcv';
import { registrarRutasBhe } from '../rest/rutas/bhe';
import { RutaHandler } from '../rest/rutas/comun';
import {
  perfil, perfilesDisponibles, descripcion, credencialParaBody, NombrePerfil, PERFILES,
} from '../perfilesVerificacion';
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
  // `empresa` es el RUT de la primera empresa que devolvió `list-empresas`, o
  // undefined si el perfil no opera ninguna.
  body: (cred: Record<string, string>, empresa?: string) => Record<string, unknown>;
  // Sondas que sólo tienen sentido con certificado: firmar.
  soloCertificado?: boolean;
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
  {
    nombre: 'firma',
    ruta: 'POST /v1/mipyme/emitir-dte',
    soloCertificado: true,
    // `confirmar` va en false y es lo único que separa leer de emitir: llega
    // hasta la previsualización y NO emite. Un `true` acá sería un acto
    // tributario real e irreversible que notifica al receptor, disparado por un
    // script de diagnóstico.
    body: (c, empresa) => ({
      ...c,
      confirmar: false,
      tipo_dte: 33,
      // Cuando el RUT opera varias empresas hay que decir con cuál: sin esto la
      // ruta responde "pasá empresa_rut" y la sonda parecía un fallo del
      // certificado cuando en realidad el certificado andaba perfecto.
      ...(empresa ? { empresa_rut: empresa } : {}),
      // El receptor va en campos planos y el RUT SIN dígito verificador, que va
      // aparte: es el contrato de la ruta, no una elección de este script.
      receptor_rut: '66666666',
      receptor_dv: '6',
      receptor_razon_social: 'Sonda de diagnostico',
      receptor_giro: 'Sonda',
      receptor_direccion: 'Sonda',
      receptor_comuna: 'Santiago',
      receptor_ciudad: 'Santiago',
      // `descripcion` tiene un tope de 25 caracteres, que es el del portal.
      lineas: [{ descripcion: 'Sonda de diagnostico', cantidad: 1, precio_unitario: 1000 }],
    }),
    significa: 'el certificado sirve para firmar; emitir-dte es viable',
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
  const cred = credencialParaBody(p);
  console.log(`  credencial: ${p.credencial.tipo}`);

  // `emitir-dte` es la única ruta que exige certificado, así que sondearla con
  // un perfil de clave sólo produciría un 400 previsible. Se salta.
  const aplicables = SONDAS.filter(
    s => !s.soloCertificado || p.credencial.tipo === 'certificado');

  // La primera empresa que aparezca: las sondas que la necesitan sólo quieren
  // UNA válida, no la correcta para un negocio.
  let empresa: string | undefined;

  for (const sonda of aplicables) {
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const handler = rutas.get(sonda.ruta);
    if (!handler) {
      console.log(`  ${sonda.nombre.padEnd(8)} SIN RUTA  ${sonda.ruta}`);
      continue;
    }
    try {
      const r = await handler(sonda.body(cred, empresa));
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (b.ok === true) {
        // El contrato envuelve los arrays en `datos`, no en un campo con el
        // nombre del recurso.
        const empresas = b.datos as { rut?: string }[] | undefined;
        if (sonda.nombre === 'mipyme' && Array.isArray(empresas)) {
          empresa = empresas[0]?.rut;
          console.log(
            `  ${sonda.nombre.padEnd(8)} SÍ    ${empresas.length} empresa(s) — ${sonda.significa}`);
          continue;
        }
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
      + `Hacen falta cuatro: ${PERFILES.join(', ')}. Ver .env.example.`);
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
