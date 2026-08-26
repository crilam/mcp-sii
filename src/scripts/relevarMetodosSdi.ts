import 'dotenv/config';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';
import { SiiHttpClient } from '../http';
import { cerrarSesionSii } from '../cerrarSesionSii';

// Releva los métodos que expone el facade SDI de un portal del SII, leyéndolos
// del JavaScript del propio portal. Es la herramienta de la Fase 0 de cada
// ronda de homologación: sin ella hay que adivinar los nombres, y adivinar no
// funciona —en RCV se probaron cuatro candidatos plausibles y fallaron los
// cuatro, mientras el nombre real era `getCtrlAsync`.
//
// Mismo método que sirvió para descubrir el PDF de BHE: lo que el portal hace,
// lo dice su propio bundle.
//
// Uso:  npm run relevar-metodos -- https://www4.sii.cl/consdcvinternetui/
//
// Sólo lectura: GET de archivos estáticos del portal con la sesión abierta.
const PORTAL = process.argv[2] ?? 'https://www4.sii.cl/consdcvinternetui/';

async function main() {
  const rut = process.env.SII_RUT;
  const clave = process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_RUT/SII_CLAVE en el entorno.');

  const sesion = new SessionManager(
    { rut, clave, strategy: AuthStrategy.Clave }, new Browser(`spike-met-${Date.now()}`));

  try {
    const http = new SiiHttpClient(sesion);
    const html = await http.get(PORTAL, {});
    console.log(`HTML del portal: ${html.length} bytes`);
    console.log('--- primeros 700 caracteres:');
    console.log(html.slice(0, 700).replace(/\s+/g, ' '));
    console.log('---');

    // Los bundles que referencia la página.
    // El portal emite los atributos SIN comillas (`<script src=https://...>`),
    // así que la regex tiene que aceptar las dos formas o no encuentra ninguno.
    const scripts = [...html.matchAll(/<script[^>]+src=(?:["']([^"']+)["']|([^\s>]+))/gi)]
      .map(m => m[1] ?? m[2]);
    console.log(`scripts referenciados: ${scripts.length}`);
    for (const s of scripts) console.log(`   ${s}`);

    // Cualquier nombre que aparezca como método del facade, en el HTML y en cada
    // bundle. El patrón es el mismo que usa `postSdi`: FacadeService/<metodo>.
    const metodos = new Set<string>();
    const buscar = (texto: string) => {
      for (const m of texto.matchAll(/FacadeService\/(\w+)/g)) metodos.add(m[1]);
      // Y el patrón suelto, por si el bundle arma el namespace por concatenación.
      for (const m of texto.matchAll(/["'](get[A-Z]\w+|solicitar\w+|crear\w+|consultar\w+)["']/g)) {
        metodos.add(m[1]);
      }
    };
    buscar(html);

    for (const src of scripts) {
      const url = src.startsWith('http') ? src : new URL(src, PORTAL).toString();
      try {
        const js = await http.get(url, {});
        console.log(`   bajado ${url.slice(-60)} (${js.length} bytes)`);
        buscar(js);
      } catch (e) {
        console.log(`   no se pudo bajar ${url.slice(-60)}: ${(e as Error).message.slice(0, 60)}`);
      }
    }

    console.log(`\nMÉTODOS CANDIDATOS (${metodos.size}):`);
    for (const m of [...metodos].sort()) console.log(`   ${m}`);
  } finally {
    await cerrarSesionSii(sesion);
  }
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
