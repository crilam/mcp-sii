import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Releva "Mi SII" (`misiir.sii.cl/cgi_misii/siihome.cgi`) para la ronda 8:
// datos del contribuyente, representantes y representados. apigateway expone
// `/sii/misii/contribuyente/datos`; el resto del dominio se descubre acá, leyendo
// lo que la página enlaza, no adivinando CGI.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-misii';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mercado') as NombrePerfil;
const TOPE = Number(process.env.RELEVO_TOPE ?? 12);
const HOME = 'https://misiir.sii.cl/cgi_misii/siihome.cgi';

async function main() {
  const p = perfil(NOMBRE);
  fs.mkdirSync(SALIDA, { recursive: true });
  const credenciales = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') {
    credenciales.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  } else {
    credenciales.guardar(p.rut, p.credencial.clave);
  }
  const registro = crearRegistroSesionesSii(credenciales);

  await registro.ejecutar(p.rut, async sesion => {
    const http = new SiiHttpClient(sesion);
    let pedidos = 0;
    const bajar = async (url: string, nombre: string) => {
      if (++pedidos > TOPE) throw new Error(`Tope de ${TOPE} pedidos.`);
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const html = await http.get(url, undefined, { guardarCookies: true });
      fs.writeFileSync(path.join(SALIDA, nombre), html, 'latin1');
      console.log(`  ${nombre.padEnd(28)} ${html.length} bytes`);
      return html;
    };
    const resumen = (html: string) => {
      const salto = /(?:location(?:\.href)?\s*=|replace\()\s*["']([^"']+)["']/.exec(html)?.[1];
      if (salto) console.log(`   salta a: ${salto}`);
      const scripts = [...html.matchAll(/<script[^>]*\ssrc=(?:["']([^"']+)["']|([^\s>]+))/gi)].map(m => m[1] ?? m[2]);
      console.log(`   scripts: ${scripts.filter(s => !/zeus|barranav|jquery|bootstrap/i.test(s)).join(', ') || '(ninguno propio)'}`);
      const enlaces = [...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
        .map(m => ({ href: m[1], texto: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }))
        .filter(e => /cgi|misii|contribuyente|representa|datos|direccion|actividad|socio/i.test(e.href + ' ' + e.texto));
      console.log(`   enlaces relevantes: ${enlaces.length}`);
      for (const e of enlaces.slice(0, 40)) console.log(`     ${e.href.slice(0, 80).padEnd(82)} ${e.texto.slice(0, 40)}`);
      const apis = [...new Set([...html.matchAll(/["'`](\/[a-zA-Z0-9_\-./]{6,}(?:services|api|rest|cgi_misii|data)[a-zA-Z0-9_\-./{}$]*)["'`]/g)].map(m => m[1]))];
      if (apis.length) console.log(`   rutas de servicio en la página: ${apis.slice(0, 30).join(', ')}`);
      const texto = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      console.log(`   texto: ${texto.slice(0, 500)}`);
      return { salto, scripts };
    };

    console.log(`Perfil ${NOMBRE} (${p.rut})\n1. Home de Mi SII`);
    const home = await bajar(HOME, 'home.html');
    const r = resumen(home);
    if (r.salto) {
      const url = new URL(r.salto, HOME).toString();
      console.log(`\n2. Destino del salto: ${url}`);
      resumen(await bajar(url, 'salto.html'));
    }
    // Los datos del contribuyente llegan por AJAX: la página trae las etiquetas
    // vacías. Los endpoints viven en los JS propios de Mi SII.
    const propios = r.scripts.filter(s => /^\/misii\/js\//.test(s) && !/wow|masonboxes|date-eu|hamburguesa|sidebar|buscador/i.test(s));
    for (const s of propios.slice(0, 6)) {
      const url = new URL(s, HOME).toString();
      const js = await bajar(url, path.basename(new URL(url).pathname));
      const rutas = [...new Set([...js.matchAll(/["'`]((?:https?:\/\/[a-z0-9.]+)?\/[a-zA-Z0-9_\-./]{4,}(?:\.cgi|services|api|rest|data|json|ajax)[a-zA-Z0-9_\-./{}$?=&]*)["'`]/g)].map(m => m[1]))];
      const urlsAjax = [...new Set([...js.matchAll(/url\s*:\s*["'`]([^"'`]{4,120})["'`]/g)].map(m => m[1]))];
      if (urlsAjax.length) { console.log(`   ${path.basename(s)} url: en $.ajax: ${urlsAjax.length}`); for (const u of urlsAjax.slice(0, 40)) console.log(`     ${u}`); }
      const ns = [...new Set([...js.matchAll(/["'](cl\.sii\.[a-zA-Z0-9_.]+(?:Service|Facade)[a-zA-Z0-9_./]*)["']/g)].map(m => m[1]))];
      console.log(`   ${path.basename(s)}: ${rutas.length} rutas, ${ns.length} namespaces`);
      for (const x of rutas.slice(0, 40)) console.log(`     ${x}`);
      for (const x of ns.slice(0, 20)) console.log(`     ns ${x}`);
    }
    console.log(`\nPedidos: ${pedidos} de ${TOPE}.`);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
