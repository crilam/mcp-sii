import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import * as core from '../core/rcvEscritura';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// Verifica el ACUSE del RCV SIN cursar nada: el catálogo de eventos (lectura) y
// el dry-run (confirmar:false, que NO muta). El acto real (confirmar:true) NO se
// ejecuta acá: requiere OK puntual del usuario y un documento de prueba.
const NOMBRE = (process.env.VERIF_PERFIL ?? 'mercado') as NombrePerfil;

async function main() {
  const p = perfil(NOMBRE);
  const cred = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') cred.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  else cred.guardar(p.rut, p.credencial.clave);
  const registro = crearRegistroSesionesSii(cred);

  console.log(`Perfil ${NOMBRE} (${p.rut})\n1. Catálogo de eventos (lectura)`);
  const eventos = await core.eventosAcuse(registro, p.rut);
  for (const e of eventos) console.log(`   ${e.codigo}: ${e.descripcion}`);

  console.log('\n2. Dry-run del acuse (confirmar:false, NO muta)');
  const docs = [{ rutEmisor: '11111111-1', tipoDoc: 33, folio: 1 }];
  const sim = await core.acusar(registro, p.rut, docs, eventos[0]?.codigo ?? 'ERM', false);
  console.log(`   ejecutado=${sim.ejecutado} evento=${sim.evento} docs=${sim.documentos.length}`);
  console.log(`   mensaje: ${sim.mensaje}`);

  console.log('\n3. Evento inválido en dry-run (debe fallar tipado, sin mutar)');
  try {
    await core.acusar(registro, p.rut, docs, 'XXX', false);
    console.log('   ERROR: no rechazó el evento inválido');
  } catch (e) {
    console.log(`   ${(e as Error).constructor.name}: ${(e as Error).message.slice(0, 100)}`);
  }
  console.log('\n(No se ejecutó ningún acuse real: confirmar:true queda para OK puntual del usuario.)');
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
