import 'dotenv/config';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';
import { SiiHttpClient } from '../http';
import { cerrarSesionSii } from '../cerrarSesionSii';

// Tercera herramienta de Fase 0. `relevarMetodosSdi` dice QUÉ métodos hay y
// `relevarFacadeRcv` qué devuelven; esto contesta la que queda: CON QUÉ
// PARÁMETROS los llama el portal.
//
// Hace falta porque hay métodos que fallan no por no existir, sino porque el
// scope que les pasamos no es el suyo: `getDatosInicio` y `getEventosDoc` no
// devuelven JSON con los parámetros de las demás llamadas, y `getDetalleDTE`
// pide un folio concreto. Adivinar el juego de parámetros es tan estéril como
// adivinar el nombre del método.
//
// Busca en el bundle el nombre del método y muestra el texto alrededor, que es
// donde el cliente arma su `data`.
//
// Uso: npm run relevar-params -- <urlBundle> <metodo> [metodo...]
const BUNDLE_POR_DEFECTO =
  'https://www4.sii.cl/consdcvinternetui/app.full.min.js';

async function main() {
  const rut = process.env.SII_RUT;
  const clave = process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_RUT/SII_CLAVE en el entorno.');

  const [urlArg, ...metodos] = process.argv.slice(2);
  const url = urlArg ?? BUNDLE_POR_DEFECTO;
  if (metodos.length === 0) {
    throw new Error('Pasá al menos un método: npm run relevar-params -- <url> getDatosInicio');
  }

  const sesion = new SessionManager(
    { rut, clave, strategy: AuthStrategy.Clave }, new Browser(`params-${Date.now()}`));

  try {
    const http = new SiiHttpClient(sesion);
    const js = await http.get(url, {});
    console.log(`bundle: ${js.length} bytes\n`);

    for (const metodo of metodos) {
      console.log(`===== ${metodo}`);
      let encontrado = 0;
      // Cada aparición del nombre, con contexto a los lados. El bundle está
      // minificado, así que el contexto es lo único legible: ahí se ve qué
      // objeto se manda como `data`.
      const re = new RegExp(metodo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      for (const m of js.matchAll(re)) {
        encontrado++;
        if (encontrado > 4) break;
        const desde = Math.max(0, (m.index ?? 0) - 260);
        const hasta = Math.min(js.length, (m.index ?? 0) + 260);
        console.log(`   [${encontrado}] ...${js.slice(desde, hasta).replace(/\s+/g, ' ')}...`);
      }
      if (!encontrado) console.log('   (no aparece en este bundle)');
      console.log();
    }
  } finally {
    await cerrarSesionSii(sesion);
  }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
