import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { RcvAsyncScraper } from '../scrapers/rcvAsync';
import { OperacionRcv } from '../scrapers/rcv';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// Verifica el scraper async completo contra el SII real: solicitar → poll →
// detalle, con el control de "filas == registros declarados".
const NOMBRE = (process.env.VERIF_PERFIL ?? 'mercado') as NombrePerfil;
const PERIODO = process.env.VERIF_PERIODO ?? '202601';
const OPERACION = (process.env.VERIF_OPERACION ?? 'COMPRA') as OperacionRcv;
const TIPODOC = Number(process.env.VERIF_TIPODOC ?? '33');

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') {
    credenciales.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  } else {
    credenciales.guardar(p.rut, p.credencial.clave);
  }
  const registro = crearRegistroSesionesSii(credenciales);

  await registro.ejecutar(p.rut, async sesion => {
    const scraper = new RcvAsyncScraper(new SiiHttpClient(sesion), sesion);
    const dormir = (ms: number) => new Promise(r => setTimeout(r, ms));
    console.log(`Perfil ${NOMBRE} (${p.rut}), ${PERIODO} ${OPERACION} tipo ${TIPODOC}\n`);

    console.log('1. solicitar');
    const sol = await scraper.solicitar(PERIODO, OPERACION, TIPODOC);
    console.log(`   solicitudId=${sol.solicitudId} estado=${sol.estado} terminada=${sol.terminada}`);

    console.log('\n2. estado (poll hasta terminar, máx 12)');
    for (let i = 0; i < 12; i++) {
      await dormir(8000);
      const est = await scraper.estado(PERIODO, OPERACION, TIPODOC);
      const s = est[0];
      console.log(`   intento ${i + 1}: estado=${s?.estado} registros=${s?.registros} blob=${s?.blobId ? 'sí' : 'no'}`);
      if (s?.terminada) break;
    }

    console.log('\n3. detalle (descarga + parseo + control filas==registros)');
    const det = await scraper.detalle(PERIODO, OPERACION, TIPODOC);
    console.log(`   ${det.filas.length} filas, ${det.columnas.length} columnas`);
    console.log(`   columnas: ${det.columnas.join(' | ').slice(0, 200)}`);
    console.log(`   primera fila: ${JSON.stringify(det.filas[0]).slice(0, 300)}`);
  });
}

main().catch(e => { console.error('ERROR:', e.constructor.name, '-', e.message); process.exit(1); });
