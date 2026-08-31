import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// Releva los nombres de método del RCV asíncrono leyendo el bundle JS del portal
// (consdcvinternetui). El portal no publica API: el facade GWT/SDI se invoca por
// nombre, y adivinar nombres siempre falló en este proyecto. Se baja el index
// autenticado, se listan sus scripts y se grepean los nombres del FacadeService
// (los síncronos ya conocidos: getResumen, getDetalleCompra, getCtrlAsync; y los
// async que faltan: crear solicitud, estado, descarga).
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-rcv-async';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mercado') as NombrePerfil;
const UI = 'https://www4.sii.cl/consdcvinternetui';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
    await sesion.authenticateOnly();
    const jar = await sesion.rutaCookieJar();
    const bajar = (url: string, dest: string) => {
      const code = execFileSync('curl', ['-s', '-b', jar, '-c', jar, '-L', '--max-time', '30', '-A', UA, '-o', dest, '-w', '%{http_code}', url], { encoding: 'utf8' });
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      return { code, size };
    };

    const idx = path.join(SALIDA, 'index.html');
    console.log('index:', bajar(`${UI}/`, idx));
    const html = fs.readFileSync(idx, 'utf8');
    // Scripts referenciados (Angular/webpack: main.*.js, runtime, polyfills, etc.)
    const scripts = Array.from(new Set(
      Array.from(html.matchAll(/(?:src|href)="([^"]+\.js)"/g)).map(m => m[1])
    ));
    console.log('scripts en el index:', scripts);

    const encontrados = new Map<string, string>();
    const metodosClave = /get(?:Resumen|DetalleCompra|DetalleVenta|CtrlAsync|[A-Za-z]*Async|[A-Za-z]*Export)|solicit[a-zA-Z]*|Solicitud[a-zA-Z]*|descarg[a-zA-Z]*|estadoProces[a-zA-Z]*/gi;

    for (const src of scripts) {
      const url = src.startsWith('http') ? src : `${UI}/${src.replace(/^\.?\//, '')}`;
      const dest = path.join(SALIDA, path.basename(src));
      const r = bajar(url, dest);
      const js = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      const hits = Array.from(new Set((js.match(metodosClave) ?? []))).sort();
      console.log(`  ${path.basename(src)} (${r.code}, ${r.size}b): ${hits.length} métodos`);
      for (const h of hits) if (!encontrados.has(h)) encontrados.set(h, path.basename(src));
    }

    console.log('\n=== métodos del facade RCV encontrados ===');
    for (const [m, f] of Array.from(encontrados.entries()).sort()) console.log(`  ${m}  (${f})`);

    // Además, alrededor de "Async" y "solicit" imprimir el contexto para ver el
    // sobre (params) de la llamada que CREA la solicitud.
    for (const src of scripts) {
      const dest = path.join(SALIDA, path.basename(src));
      if (!fs.existsSync(dest)) continue;
      const js = fs.readFileSync(dest, 'utf8');
      for (const m of js.matchAll(/.{80}(?:getCtrlAsync|[A-Za-z]+Async|Export|solicit[a-zA-Z]*).{80}/gi)) {
        const frag = m[0].replace(/\s+/g, ' ');
        if (/facade|FacadeService|namespace|metaData|conversationId|getData|servicio/i.test(frag)) {
          console.log('   ctx:', frag.slice(0, 200));
        }
      }
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
