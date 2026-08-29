import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Segunda pasada sobre Mi SII: la home trae las etiquetas vacías y los datos
// llegan por AJAX. `misii.min.js` los pide con POST a `/cgi_misii/client001.cgi`
// y a `/misii/html/datatrib.html`, con `OPT=<n>&VIEW=1`. Acá se piden las
// opciones que el bundle declara y se mira qué fragmento devuelve cada una.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-misii';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mercado') as NombrePerfil;
const HOME = 'https://misiir.sii.cl/cgi_misii/siihome.cgi';
const CLIENT = 'https://misiir.sii.cl/cgi_misii/client001.cgi';
const DATATRIB = 'https://misiir.sii.cl/misii/html/datatrib.html';

const OPCIONES: { url: string; opt: string; que: string }[] = [
  { url: DATATRIB, opt: '1', que: 'datos tributarios (json)' },
  { url: CLIENT, opt: '7', que: 'client001 OPT 7' },
  { url: CLIENT, opt: '12', que: 'direcciones' },
  { url: CLIENT, opt: '24', que: 'client001 OPT 24' },
  { url: CLIENT, opt: '25', que: 'client001 OPT 25' },
  { url: CLIENT, opt: '26', que: 'client001 OPT 26' },
];

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
    // La home primero: deja la sesión de Mi SII armada (cookies propias).
    await http.get(HOME, undefined, { guardarCookies: true });
    for (const o of OPCIONES) {
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const cuerpo = await http.postForm(o.url, { OPT: o.opt, VIEW: '1' });
      const nombre = `opt-${o.opt}.html`;
      fs.writeFileSync(path.join(SALIDA, nombre), cuerpo, 'latin1');
      const texto = cuerpo.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' | ').replace(/(\s*\|\s*)+/g, ' | ').replace(/\s+/g, ' ').trim();
      console.log(`\n== ${o.que} (${o.url.split('/').pop()} OPT=${o.opt}) ${cuerpo.length} bytes`);
      console.log('   ' + texto.slice(0, 600));
    }
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
