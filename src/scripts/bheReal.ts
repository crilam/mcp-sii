import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { BheEmisionScraper } from '../scrapers/bheEmision';
import { cerrarSesionSii } from '../cerrarSesionSii';

// Boleta de honorarios REAL por env. Por defecto PREVISUALIZA (pasos 1→3, NO
// emite) e imprime los montos que calculó EL SII. Sólo con BHE_CONFIRMAR=SI se
// ejecuta el paso 4: acto tributario REAL e irreversible que notifica al
// receptor — por eso el flag es explícito y no un default, y conviene correr
// el script con el env limpio (un BHE_CONFIRMAR heredado de otra corrida
// emitiría de verdad).
async function main() {
  const rut = process.env.SII_RUT!;
  const clave = process.env.SII_CLAVE!;
  const cred = new ProveedorCredencialesRuntime();
  cred.guardar(rut, clave);
  const registro = crearRegistroSesionesSii(cred);

  // Los datos de la boleta van por env, NUNCA hardcodeados acá: son datos reales
  // (RUT del receptor, glosas) y este archivo se versiona.
  //   BHE_RECEPTOR_RUT, BHE_RECEPTOR_NOMBRE, BHE_LINEAS='desc|valor;desc|valor'
  const receptorRut = process.env.BHE_RECEPTOR_RUT;
  const receptorNombre = process.env.BHE_RECEPTOR_NOMBRE;
  if (!receptorRut || !receptorNombre || !process.env.BHE_LINEAS) {
    throw new Error('Faltan BHE_RECEPTOR_RUT / BHE_RECEPTOR_NOMBRE / BHE_LINEAS en el entorno.');
  }
  const lineas = process.env.BHE_LINEAS.split(';').map(l => {
    const [descripcion, valor] = l.split('|');
    return { descripcion, valor: parseInt(valor, 10) };
  });
  const confirmar = process.env.BHE_CONFIRMAR === 'SI';
  const fecha = process.env.BHE_FECHA; // AAAA-MM-DD; si falta, la del portal
  const params = { receptor: { rut: receptorRut, nombre: receptorNombre }, lineas, retieneReceptor: true, fecha };

  await registro.ejecutar(rut, async sesion => {
    try {
      const scraper = new BheEmisionScraper(new SiiHttpClient(sesion), sesion);
      console.log(`Emisor ${rut} — ${confirmar ? 'EMISIÓN REAL' : 'PREVISUALIZACIÓN (no emite)'}\n`);
      const r = await scraper.emitir(params, confirmar);
      console.log(`  Bruto (SII):     $ ${r.bruto?.toLocaleString('es-CL') ?? '?'}`);
      console.log(`  Retención (SII): $ ${r.retencion?.toLocaleString('es-CL') ?? '?'}`);
      console.log(`  Líquido (SII):   $ ${r.liquido?.toLocaleString('es-CL') ?? '?'}`);
      if (r.emitida) {
        console.log(`\n  BOLETA EMITIDA. Folio: ${r.folio ?? 'no legible — confirmar con la lectura de emitidas'}`);
        console.log(`\n  Detalle:\n  ${r.detalle.slice(0, 600)}`);
      } else {
        console.log(`  Tipo retención (SII): ${r.tipoRetencion ?? 'no legible'}`);
        console.log(`\n  Detalle de la previsualización:\n  ${r.detalle.slice(0, 600)}`);
        console.log('\n  NO SE EMITIÓ NADA. Para emitir: BHE_CONFIRMAR=SI.');
      }
    } finally {
      // No dejar la sesión viva en el SII: los scripts sueltos no pasan por el
      // desalojo del registro y acumulan "Numero excesivo de sesiones".
      await cerrarSesionSii(sesion).catch(() => undefined);
    }
  });
}
main().catch(e => { console.error('ERROR:', e.constructor?.name, '-', e.message); process.exit(1); });
