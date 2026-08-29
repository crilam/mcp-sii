import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Releva el portal de bienes raíces (`vica`), que es una SPA. La ruta que hoy
// existe la lee con navegador y parsea el snapshot de accesibilidad; para las
// que faltan —certificados de avalúo, antecedentes, comunas— lo que interesa es
// la API que la SPA llama por detrás, y eso se lee de su bundle. Es la técnica
// que funcionó con el RCV y con los borradores de mipyme.
//
// Con ritmo y tope: el SII cuenta las requests por patrón de uso.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-bienes-raices';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'certificado') as NombrePerfil;
const TOPE = Number(process.env.RELEVO_TOPE ?? 10);

const PORTAL = 'https://www2.sii.cl/vica/Menu/BienesRaices';

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
    const bajar = async (url: string, nombre: string) => {
      if (++pedidos > TOPE) throw new Error(`Tope de ${TOPE} pedidos alcanzado.`);
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const cuerpo = await http.get(url);
      fs.writeFileSync(path.join(SALIDA, nombre), cuerpo, 'latin1');
      console.log(`  ${nombre.padEnd(34)} ${cuerpo.length} bytes`);
      return cuerpo;
    };

    console.log(`Perfil ${NOMBRE} (${p.rut})\n1. Portal`);
    const index = await bajar(PORTAL, 'index.html');

    const scripts = [...index.matchAll(/<script[^>]*\ssrc=(?:["']([^"']+)["']|([^\s>]+))/gi)]
      .map(m => m[1] ?? m[2]);
    console.log(`   scripts: ${scripts.join(', ') || '(ninguno)'}`);
    // Un salto por JS o meta refresh significa que el portal real vive en otra URL.
    const salto = /(?:location(?:\.href)?\s*=|replace\()\s*["']([^"']+)["']/.exec(index)?.[1]
      ?? /http-equiv=["']refresh["'][^>]*url=([^"'>]+)/i.exec(index)?.[1];
    if (salto) console.log(`   salta a: ${salto}`);

    console.log('\n2. Bundles y endpoints que declaran');
    const base = new URL(PORTAL);
    for (const s of scripts.filter(s => /\.js($|\?)/i.test(s) && !/zeus|barranav/i.test(s))) {
      const url = new URL(s, base).toString();
      const nombre = path.basename(new URL(url).pathname);
      const js = await bajar(url, nombre);

      // Todo lo que parezca ruta de servicio. Sin filtrar por corazonada: lo que
      // importa es lo que declara el portal, no lo que esperábamos.
      const rutas = [...new Set([...js.matchAll(/["'`](\/[a-zA-Z0-9_\-./]{6,}(?:services|api|cgi|data|rest)[a-zA-Z0-9_\-./{}$]*)["'`]/g)].map(m => m[1]))];
      const abs = [...new Set([...js.matchAll(/["'`](https?:\/\/[a-z0-9.]*sii\.cl\/[^"'`\s]{4,})["'`]/g)].map(m => m[1]))];
      const ns = [...new Set([...js.matchAll(/["'](cl\.sii\.[a-zA-Z0-9_.]+(?:Service|Facade)[a-zA-Z0-9_./]*)["']/g)].map(m => m[1]))];
      console.log(`   ${nombre}: ${rutas.length} rutas, ${abs.length} URLs absolutas, ${ns.length} namespaces`);
      for (const r of rutas.slice(0, 60)) console.log(`     ${r}`);
      for (const r of abs.slice(0, 30)) console.log(`     ${r}`);
      for (const r of ns.slice(0, 30)) console.log(`     ns ${r}`);
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
