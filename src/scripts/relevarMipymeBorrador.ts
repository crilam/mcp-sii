import 'dotenv/config';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Releva CÓMO el portal mipyme guarda un BORRADOR de DTE, por LECTURA pura: baja
// el form de emisión (`mipeGenFacEx.cgi`) autenticado y busca los <form action>,
// los submits con nombre, y las menciones de ES_BORR / borrador / graba. NO hace
// ningún POST que grabe: sólo GET. El campo `ES_BORR` (visto en
// armarCamposEmision) es la señal del borrador; acá se ve a qué CGI apunta.
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mipyme') as NombrePerfil;
const TIPO = process.env.RELEVO_TIPO ?? '33';
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-mipyme-borrador';
const SEL = 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi';
const FORM = 'https://www1.sii.cl/cgi-bin/Portal001/mipeGenFacEx.cgi';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const p = perfil(NOMBRE);
  fs.mkdirSync(SALIDA, { recursive: true });
  const cred = new ProveedorCredencialesRuntime();
  if (p.credencial.tipo === 'certificado') cred.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  else cred.guardar(p.rut, p.credencial.clave);
  const registro = crearRegistroSesionesSii(cred);

  await registro.ejecutar(p.rut, async sesion => {
    await sesion.authenticateOnly();
    const jar = await sesion.rutaCookieJar();
    const dormir = () => new Promise(r => setTimeout(r, pausaConfigurada()));
    const get = (url: string, params: Record<string, string> = {}) => {
      const q = new URLSearchParams(params).toString();
      return execFileSync('curl', ['-s', '-b', jar, '-c', jar, '-L', '--max-time', '40', '-A', UA, q ? `${url}?${q}` : url], { encoding: 'latin1', maxBuffer: 20 * 1024 * 1024 });
    };

    console.log(`Perfil ${NOMBRE} (${p.rut})\n1. Empresas disponibles`);
    const selHtml = get(SEL);
    const empresas = Array.from(new Set([...selHtml.matchAll(/<option value="([0-9]{5,}-[0-9kK])"/gi)].map(m => m[1])));
    console.log(`   empresas: ${empresas.join(', ') || '(no parseadas — ver dump)'}`);
    fs.writeFileSync(`${SALIDA}/sel.html`, selHtml, 'latin1');
    const emp = process.env.RELEVO_EMPRESA ?? empresas[0];
    if (!emp) { console.log('   sin empresa; abortando'); return; }

    console.log(`\n2. Seleccionar empresa ${emp} (POST de selección, no es escritura de DTE)`);
    await dormir();
    execFileSync('curl', ['-s', '-b', jar, '-c', jar, '--max-time', '40', '-A', UA, '--data', `RUT_EMP=${emp}`, SEL], { encoding: 'latin1' });

    console.log(`\n3. GET del form de emisión (tipo ${TIPO}) — LECTURA`);
    await dormir();
    const form = get(FORM, { PTDC_CODIGO: TIPO });
    fs.writeFileSync(`${SALIDA}/form.html`, form, 'latin1');
    console.log(`   form.html -> ${form.length} bytes`);

    console.log('\n   <form action=...>:');
    for (const m of form.matchAll(/<form[^>]*>/gi)) console.log(`     ${m[0].replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log('\n   submits / botones (name/value):');
    for (const m of form.matchAll(/<(?:input|button)[^>]*type=["']?(?:submit|button)[^>]*>/gi)) console.log(`     ${m[0].replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log('\n   campos ES_BORR / EHDR_CODIGO / borrador:');
    for (const m of form.matchAll(/<input[^>]*(?:ES_BORR|EHDR_CODIGO)[^>]*>/gi)) console.log(`     ${m[0].replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log('\n   menciones de borrador/graba (contexto):');
    for (const m of form.matchAll(/.{40}(?:[Bb]orrador|graba[A-Za-z]*|Graba[A-Za-z]*|mipe[A-Za-z]*\.cgi).{40}/g)) {
      const frag = m[0].replace(/\s+/g, ' ');
      if (/borrador|graba|\.cgi/i.test(frag)) console.log(`     ${frag.slice(0, 160)}`);
    }
  });
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
