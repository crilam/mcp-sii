import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// Releva con NAVEGADOR la consulta de estado de declaraciones F29 (`rfiInternet`).
//
// Es una aplicación GWT: su bootstrap (`rfi.nocache.js`) elige una permutación
// compilada y habla por GWT-RPC, un protocolo serializado que no se lee del
// bundle como las APIs SDI. Por eso acá no se buscan endpoints: se abre la app
// en el navegador de la sesión y se mira el snapshot de accesibilidad, que es lo
// que un scraper de navegador va a parsear. Mismo camino que tuvo bienes raíces
// antes de encontrarle la API.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-f29-browser';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mercado') as NombrePerfil;
const ESTADO = 'https://www4.sii.cl/rfiInternet/consulta/index.html';
const INTEGRAL = 'https://www4.sii.cl/sifmConsultaInternet/index.html?dest=cifxx&form=29';

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
    await sesion.authenticateOnly();
    const browser = sesion.obtenerBrowser();

    const refDe = (snap: string, patron: RegExp): string | undefined => {
      for (const l of snap.split('\n')) {
        const m = patron.exec(l);
        if (m) { const r = /\[ref=(e\d+)\]/.exec(l); if (r) return r[1]; }
      }
      return undefined;
    };
    const guardar = (nombre: string, snap: string) => {
      fs.writeFileSync(path.join(SALIDA, `${nombre}.snapshot.txt`), snap);
      console.log(`   ${nombre}: ${snap.length} chars`);
    };

    console.log(`== integral: ${INTEGRAL}`);
    browser.open(INTEGRAL);
    browser.waitForAny(['CONSULTA INTEGRAL', 'Formulario'], 40_000);
    let snap = browser.snapshot();
    guardar('integral-1', snap);

    // Desplegar los períodos del F29.
    const masF29 = refDe(snap, /link "F29 \(\+\)"/);
    console.log(`   F29 (+) -> ${masF29}`);
    if (masF29) {
      browser.click(masF29);
      browser.waitForAny(['Ene', 'Feb', 'Mar', 'Dic', 'Periodo'], 20_000);
      snap = browser.snapshot();
      guardar('integral-2-periodos', snap);
      const filas = snap.split('\n').filter(l => /link "|cell "/.test(l)).slice(0, 120);
      console.log(filas.join('\n'));

      // Cada período es una IMAGEN clicable (la letra del estado es un gif), así
      // que el snapshot no dice qué estado tiene: se lee del DOM.
      // `eval` devuelve texto; si ese texto es a su vez un JSON entre comillas,
      // se parsea dos veces. Las imágenes son sprites de GWT (`clear.cache.gif`):
      // la letra del estado vive en la CLASE css, no en el src.
      const parsearEval = (t: string): unknown => { let v: unknown = JSON.parse(t); if (typeof v === 'string') v = JSON.parse(v); return v; };
      const imagenes = parsearEval(browser.eval(`JSON.stringify(Array.from(document.querySelectorAll('td img')).slice(0, 30).map(i => ({src: (i.getAttribute('src')||'').slice(0,60), bgi: getComputedStyle(i).backgroundImage.slice(0,90), style: (i.getAttribute('style')||'').slice(0,120)})))`)) as Record<string, string>[];
      console.log('\n   imágenes de períodos (clase css / fondo):');
      for (const im of imagenes) console.log(`     ${JSON.stringify(im)}`);

      const primera = refDe(snap, /- image \[ref=e\d+\] clickable/);
      console.log(`\n   click en la primera imagen -> ${primera}`);
      if (primera) {
        const antes = browser.eval('String(window.open ? 1 : 0)');
        browser.eval(`window.__abiertas = []; const _o = window.open; window.open = function(u){ window.__abiertas.push(String(u)); return _o ? _o.apply(this, arguments) : null; };`);
        browser.click(primera);
        try { browser.waitForAny(['Formulario 29', 'FORMULARIO 29', 'Declaraci', 'Folio', 'compacto', 'Compacto', 'Código'], 15_000); } catch { /* puede no cambiar la página */ }
        console.log(`   window.open interceptadas: ${browser.eval('JSON.stringify(window.__abiertas || [])')}  (${antes})`);
        snap = browser.snapshot();
        guardar('integral-3-declaracion', snap);
        console.log(`   url: ${browser.getUrl()}`);
        const interesantes = snap.split('\n').filter(l =>
          /link |button |heading |compacto|Compacto|PDF|pdf|Folio|folio|Estado|estado|Total|Código|Periodo|Período/.test(l)).slice(0, 90);
        console.log(interesantes.join('\n'));
        const enlaces = parsearEval(browser.eval(`JSON.stringify(Array.from(document.querySelectorAll('a[href], input[type=button], button, td img')).slice(0, 40).map(a => ({t: (a.textContent||a.value||a.alt||a.title||'').trim().slice(0,40), href: a.getAttribute('href'), cls: a.className})))`)) as Record<string, string>[];
        console.log('\n   enlaces/botones del DOM:');
        for (const e of enlaces) console.log(`     ${JSON.stringify(e)}`);
      }
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
