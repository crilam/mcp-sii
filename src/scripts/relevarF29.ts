import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Releva las dos puertas del F29 en el SII para la ronda 6.
//
//  1. La "Consulta integral" de declaraciones (`sifmConsultaInternet`), donde el
//     contribuyente ve el estado de sus F29 presentados y baja el formulario
//     compacto. Es una SPA: lo que interesa es su bundle, para leer la API.
//  2. La "Propuesta de F29" del portal mipyme (`/cgi_csm/csmSelPeriodoF29.cgi`),
//     que apareció al relevar la ronda 2 desde el menú de Facturación Gratuita.
//
// Con ritmo y tope: el SII cuenta por patrón de uso.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-f29';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mercado') as NombrePerfil;
const TOPE = Number(process.env.RELEVO_TOPE ?? 12);

// Las dos apps que el menú de "Impuestos mensuales" enlaza para consultar F29;
// ambas redirigen al login sin sesión, así que sólo se pueden relevar desde acá.
const CONSULTA = 'https://www4.sii.cl/sifmConsultaInternet/index.html?dest=cifxx&form=29';
const ESTADO = 'https://www4.sii.cl/rfiInternet/consulta/index.html';
const PROPUESTA = 'https://www1.sii.cl/cgi_csm/csmSelPeriodoF29.cgi';

async function main() {
  const p = perfil(NOMBRE);
  fs.mkdirSync(SALIDA, { recursive: true });

  const credenciales = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') {
    credenciales.guardarCertificado(
      p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword,
      process.env.SII_CERT_CLAVE_SII);
  } else {
    credenciales.guardar(p.rut, p.credencial.clave);
  }
  const registro = crearRegistroSesionesSii(credenciales);

  await registro.ejecutar(p.rut, async sesion => {
    const http = new SiiHttpClient(sesion);
    let pedidos = 0;
    const bajar = async (url: string, nombre: string, params?: Record<string, string>) => {
      if (++pedidos > TOPE) throw new Error(`Tope de ${TOPE} pedidos alcanzado.`);
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const cuerpo = await http.get(url, params, { guardarCookies: true });
      fs.writeFileSync(path.join(SALIDA, nombre), cuerpo, 'latin1');
      console.log(`  ${nombre.padEnd(30)} ${cuerpo.length} bytes`);
      return cuerpo;
    };
    const scriptsDe = (html: string, base: string) =>
      [...html.matchAll(/<script[^>]*\ssrc=(?:["']([^"']+)["']|([^\s>]+))/gi)]
        .map(m => new URL(m[1] ?? m[2], base).toString());
    const salto = (html: string) =>
      /(?:location(?:\.href)?\s*=|replace\()\s*["']([^"']+)["']/.exec(html)?.[1]
      ?? /http-equiv=["']refresh["'][^>]*url=([^"'>]+)/i.exec(html)?.[1];

    console.log(`Perfil ${NOMBRE} (${p.rut})\n1. Consulta integral F29`);
    const index = await bajar(CONSULTA, 'consulta-index.html');
    const s1 = salto(index);
    if (s1) console.log(`   salta a: ${s1}`);
    const scripts = scriptsDe(index, CONSULTA).filter(s => /\.js($|\?)/i.test(s) && !/zeus|barranav|common-1\.0/i.test(s));
    console.log(`   scripts: ${scripts.join(', ') || '(ninguno)'}`);
    for (const s of scripts.slice(0, 3)) {
      const js = await bajar(s, path.basename(new URL(s).pathname));
      const rutas = [...new Set([...js.matchAll(/["'`](\/[a-zA-Z0-9_\-./]{6,}(?:services|api|rest|data|cgi)[a-zA-Z0-9_\-./{}$]*)["'`]/g)].map(m => m[1]))];
      const ns = [...new Set([...js.matchAll(/["'](cl\.sii\.[a-zA-Z0-9_.]+(?:Service|Facade)[a-zA-Z0-9_./]*)["']/g)].map(m => m[1]))];
      console.log(`   ${path.basename(s)}: ${rutas.length} rutas, ${ns.length} namespaces`);
      for (const r of rutas.slice(0, 40)) console.log(`     ${r}`);
      for (const r of ns.slice(0, 20)) console.log(`     ns ${r}`);
    }

    console.log('\n1b. Consultar estado de declaración (rfiInternet)');
    const est = await bajar(ESTADO, 'estado-index.html');
    const s3 = salto(est);
    if (s3) console.log(`   salta a: ${s3}`);
    const scripts2 = scriptsDe(est, ESTADO).filter(s => /\.js($|\?)/i.test(s) && !/zeus|barranav|common-1\.0/i.test(s));
    console.log(`   scripts: ${scripts2.join(', ') || '(ninguno)'}`);
    for (const m of est.matchAll(/<form[^>]*>/gi)) console.log(`   ${m[0].slice(0, 140)}`);
    for (const s of scripts2.slice(0, 3)) {
      const js = await bajar(s, path.basename(new URL(s).pathname));
      const rutas = [...new Set([...js.matchAll(/["'`](\/[a-zA-Z0-9_\-./]{6,}(?:services|api|rest|data|cgi)[a-zA-Z0-9_\-./{}$]*)["'`]/g)].map(m => m[1]))];
      const ns = [...new Set([...js.matchAll(/["'](cl\.sii\.[a-zA-Z0-9_.]+(?:Service|Facade)[a-zA-Z0-9_./]*)["']/g)].map(m => m[1]))];
      console.log(`   ${path.basename(s)}: ${rutas.length} rutas, ${ns.length} namespaces`);
      for (const r of rutas.slice(0, 40)) console.log(`     ${r}`);
      for (const r of ns.slice(0, 20)) console.log(`     ns ${r}`);
    }

    console.log('\n2. Propuesta F29 (mipyme)');
    const prop = await bajar(PROPUESTA, 'propuesta.html');
    const s2 = salto(prop);
    if (s2) console.log(`   salta a: ${s2}`);
    for (const m of prop.matchAll(/<form[^>]*>/gi)) console.log(`   ${m[0].slice(0, 140)}`);
    const campos = [...new Set([...prop.matchAll(/<(?:input|select)[^>]*name=["']([^"']+)["']/gi)].map(m => m[1]))];
    if (campos.length) console.log(`   campos: ${campos.join(', ')}`);
    console.log('   texto: ' + prop.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400));
    console.log(`\nPedidos: ${pedidos} de ${TOPE}. Archivos en ${SALIDA}`);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
