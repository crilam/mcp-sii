import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { MipymeHttpScraper } from '../scrapers/mipymeHttp';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Releva lo que falta de la ronda 2: la descarga de XML y los borradores.
//
// Los borradores NO son un CGI del portal viejo: el menú los publica con una
// función JavaScript (`printLinkAdmBorradores`) definida en `valores.js`, que
// arma un enlace a `https://www4.sii.cl/mipymeinternetui/#!/borradores` — una
// aplicación moderna, con su propia API detrás. O sea que homologarlos no es
// "otro CGI más", es relevar otra API, como pasó con el RCV.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-mipyme-resto';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'certificado') as NombrePerfil;
const EMPRESA = process.env.RELEVO_EMPRESA;

// `auth.html` —que es lo que enlaza el menú— NO es la página de la descarga: su
// único contenido útil es un `window.location.href` a este CGI. Relevar el
// `.html` daba un falso negativo, "el portal no ofrece XML", sobre un camino que
// sí existe y que hoy usa `MipymeHttpScraper.respaldoXml`.
const AUTH_DESCARGA = 'https://www1.sii.cl/cgi-bin/Portal001/auth.cgi';
const SPA_BORRADORES = 'https://www4.sii.cl/mipymeinternetui/';

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
    const scraper = new MipymeHttpScraper(http, sesion);

    const empresas = await scraper.listEmpresas();
    const activa = EMPRESA ?? empresas[0].rut;
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    await http.postForm('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi',
      { RUT_EMP: activa });
    console.log(`Empresa activa: ${activa}\n`);

    // 1. La página de "Descargar información electrónica (DTE y/o IECV)", que es
    //    el único camino del menú que menciona XML.
    console.log('1. Descarga de información electrónica');
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const auth = await http.get(AUTH_DESCARGA);
    fs.writeFileSync(path.join(SALIDA, 'auth-descarga.html'), auth, 'latin1');
    console.log(`   auth.html -> ${auth.length} bytes`);
    for (const m of auth.matchAll(/<form[^>]*>/gi)) console.log(`   ${m[0].slice(0, 140)}`);
    const campos = [...auth.matchAll(/<(?:input|select)[^>]*name=["']([^"']+)["']/gi)].map(m => m[1]);
    if (campos.length) console.log(`   campos: ${[...new Set(campos)].join(', ')}`);
    const recaptchaAuth = /recaptcha/i.test(auth);
    console.log(`   reCAPTCHA: ${recaptchaAuth ? 'SÍ' : 'no'}`);

    // 2. La aplicación de borradores. Interesa su bundle: los nombres de los
    //    métodos de su API no se adivinan, se leen de ahí. Es la técnica que
    //    funcionó con el RCV después de que cuatro nombres "obvios" fallaran.
    console.log('\n2. Aplicación de borradores');
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const spa = await http.get(SPA_BORRADORES);
    fs.writeFileSync(path.join(SALIDA, 'spa-borradores.html'), spa, 'latin1');
    console.log(`   index -> ${spa.length} bytes`);

    // Los atributos de esta página vienen SIN comillas (`src=app.full.min.js?...`),
    // así que un patrón que las exija no encuentra el bundle y el relevamiento
    // reporta "sin scripts" sobre una página que los tiene.
    const bundles = [...spa.matchAll(/<script[^>]*\ssrc=(?:["']([^"']+)["']|([^\s>]+))/gi)]
      .map(m => m[1] ?? m[2]);
    console.log(`   scripts: ${bundles.join(', ') || '(ninguno)'}`);

    for (const b of bundles.filter(b => /\.js($|\?)/i.test(b))) {
      const url = new URL(b, SPA_BORRADORES).toString();
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const js = await http.get(url);
      const nombre = path.basename(new URL(url).pathname);
      fs.writeFileSync(path.join(SALIDA, nombre), js, 'latin1');
      console.log(`   ${nombre} -> ${js.length} bytes`);

      // Endpoints que declara el bundle. Se listan sin filtrar por corazonada:
      // lo que importa es qué dice el portal, no qué esperábamos encontrar.
      const rutas = [...new Set([...js.matchAll(/["'](\/[a-zA-Z0-9_\-/]{4,}(?:borrador|Borrador|dte|DTE)[a-zA-Z0-9_\-/]*)["']/g)].map(m => m[1]))];
      if (rutas.length) {
        console.log('     rutas con borrador/dte:');
        for (const r of rutas.slice(0, 25)) console.log(`       ${r}`);
      }
      const servicios = [...new Set([...js.matchAll(/["']([a-zA-Z0-9_]*(?:[Ss]ervice|Facade|facade)[a-zA-Z0-9_]*)["']/g)].map(m => m[1]))];
      if (servicios.length) console.log(`     servicios: ${servicios.slice(0, 15).join(', ')}`);
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
