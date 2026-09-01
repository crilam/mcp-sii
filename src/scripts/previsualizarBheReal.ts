import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { BheEmisionScraper } from '../scrapers/bheEmision';

// PREVISUALIZA la boleta real del usuario (pasos 1→3, NO emite). Los montos que
// imprime son los que calculó EL SII. La emisión real es una decisión aparte.
async function main() {
  const rut = process.env.SII_RUT!;
  const clave = process.env.SII_CLAVE!;
  const cred = new ProveedorCredencialesRuntime();
  cred.guardar(rut, clave);
  const registro = crearRegistroSesionesSii(cred);

  // Los datos de la boleta van por env, NUNCA hardcodeados acá: son datos reales
  // (RUT del receptor, glosas) y este archivo se versiona.
  //   BHE_RECEPTOR_RUT, BHE_RECEPTOR_NOMBRE, BHE_LINEAS='desc|valor;desc|valor'
  const receptorRut = process.env.BHE_RECEPTOR_RUT!;
  const receptorNombre = process.env.BHE_RECEPTOR_NOMBRE!;
  const lineas = process.env.BHE_LINEAS!.split(';').map(l => {
    const [descripcion, valor] = l.split('|');
    return { descripcion, valor: parseInt(valor, 10) };
  });
  if (!receptorRut || !receptorNombre || lineas.length === 0) {
    throw new Error('Faltan BHE_RECEPTOR_RUT / BHE_RECEPTOR_NOMBRE / BHE_LINEAS en el entorno.');
  }
  const params = { receptor: { rut: receptorRut, nombre: receptorNombre }, lineas, retieneReceptor: true };

  await registro.ejecutar(rut, async sesion => {
    const scraper = new BheEmisionScraper(new SiiHttpClient(sesion), sesion);
    console.log(`Emisor ${rut} — PREVISUALIZACIÓN (no emite)\n`);
    const r = await scraper.emitir(params, false);
    if (r.emitida) throw new Error('imposible: confirmar era false');
    console.log(`  Bruto (SII):     $ ${r.bruto?.toLocaleString('es-CL') ?? '?'}`);
    console.log(`  Retención (SII): $ ${r.retencion?.toLocaleString('es-CL') ?? '?'}`);
    console.log(`  Líquido (SII):   $ ${r.liquido?.toLocaleString('es-CL') ?? '?'}`);
    console.log(`\n  Detalle de la previsualización:\n  ${r.detalle.slice(0, 600)}`);
    console.log('\n  NO SE EMITIÓ NADA. Para emitir hace falta el OK explícito.');
  });
}
main().catch(e => { console.error('ERROR:', e.constructor?.name, '-', e.message); process.exit(1); });
