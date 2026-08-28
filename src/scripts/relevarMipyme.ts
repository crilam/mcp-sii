import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { pausaConfigurada } from '../ritmoSii';

// Releva el portal mipyme: qué CGI ofrece el menú una vez seleccionada la
// empresa, y qué formularios expone cada uno.
//
// NO se adivinan nombres de CGI. En la ronda 1 se probaron cuatro nombres
// "obvios" para los métodos del RCV y fallaron los cuatro; lo que funcionó fue
// leer lo que el portal declara. Acá vale lo mismo: `mipeAdminDocsEmi.cgi` es el
// historial de emitidos, y suena a que recibidos sería `...Rec.cgi`, pero eso es
// una corazonada, no un dato.
//
// Va con ritmo y con tope: el SII bloquea por patrón de uso, y quedarse sin el
// portal mipyme deja al SERVICIO sin poder consultarlo para los tenants reales.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-mipyme';
const CGI_BASE = 'https://www1.sii.cl/cgi-bin/Portal001';
const SEL_EMPRESA_URL = `${CGI_BASE}/mipeSelEmpresa.cgi`;

// Tope duro de páginas a bajar en una corrida. Un relevamiento sin tope es
// exactamente el barrido que bloqueó el RCV.
const TOPE_PAGINAS = Number(process.env.RELEVO_TOPE ?? 12);

function enlacesDe(html: string): { href: string; texto: string }[] {
  const salida: { href: string; texto: string }[] = [];
  for (const m of html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const texto = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
    salida.push({ href: m[1], texto });
  }
  return salida;
}

function formulariosDe(html: string): string[] {
  return [...html.matchAll(/<form[^>]*>/gi)].map(m => m[0]);
}

async function main() {
  const rut = process.env.SII_EMPRESA_RUT ?? process.env.SII_RUT;
  if (!rut) throw new Error('Falta SII_EMPRESA_RUT (o SII_RUT) en el .env.');

  fs.mkdirSync(SALIDA, { recursive: true });

  const clave = process.env.SII_EMPRESA_CLAVE ?? process.env.SII_CLAVE;
  if (!clave) throw new Error('Falta SII_EMPRESA_CLAVE (o SII_CLAVE) en el .env.');

  // El proveedor de runtime es el mismo que usa el adaptador REST, y espera que
  // la credencial se registre antes: en producción llega en el body de la
  // request, acá la pone el .env.
  const credenciales = new ProveedorCredencialesRuntime();
  credenciales.guardar(rut, clave);
  const registro = crearRegistroSesionesSii(credenciales);

  // `ejecutar` es el mismo camino que usan las rutas: encola por RUT y cierra la
  // sesión al terminar. Un relevamiento que abriera la sesión a mano le comería
  // el cupo de sesiones simultáneas a los tenants reales si algo fallara.
  await registro.ejecutar(rut, async sesion => {
    const http = new SiiHttpClient(sesion);
    let bajadas = 0;

    const bajar = async (url: string, nombre: string, params?: Record<string, string>) => {
      if (bajadas >= TOPE_PAGINAS) {
        console.log(`  TOPE alcanzado (${TOPE_PAGINAS}); no se baja ${nombre}.`);
        return null;
      }
      bajadas++;
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const html = await http.get(url, params);
      fs.writeFileSync(path.join(SALIDA, `${nombre}.html`), html, 'latin1');
      console.log(`  ${nombre.padEnd(28)} ${html.length} bytes`);
      return html;
    };

    console.log('1. Selección de empresa');
    const selector = await bajar(SEL_EMPRESA_URL, 'sel-empresa');
    if (!selector) return;

    const enlacesSelector = enlacesDe(selector).filter(e => /\.cgi/i.test(e.href));
    console.log(`  enlaces en el selector: ${enlacesSelector.length}`);

    console.log('\n2. Menú del portal, ya con empresa activa');
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const menu = await http.postForm(SEL_EMPRESA_URL, { RUT_EMP: rut.replace(/\./g, '') });
    fs.writeFileSync(path.join(SALIDA, 'menu.html'), menu, 'latin1');

    const enlaces = enlacesDe(menu).filter(e => /\.cgi|\.html?/i.test(e.href));
    console.log(`  ${enlaces.length} enlaces en el menú:`);
    for (const e of enlaces) {
      console.log(`    ${e.href.slice(0, 60).padEnd(62)} ${e.texto.slice(0, 46)}`);
    }
    fs.writeFileSync(
      path.join(SALIDA, 'enlaces.json'), JSON.stringify(enlaces, null, 2));

    console.log(`\n  formularios del menú: ${formulariosDe(menu).length}`);
    for (const f of formulariosDe(menu)) console.log(`    ${f.slice(0, 120)}`);

    console.log(`\nHTML guardado en ${SALIDA}. Bajadas: ${bajadas} de ${TOPE_PAGINAS}.`);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
