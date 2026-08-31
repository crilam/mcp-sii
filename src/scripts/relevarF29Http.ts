import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';
import { codificarLong, decodificarLong } from '../scrapers/gwtRpc';

// ¿Se puede hacer TODO el F29 por HTTP, sin navegador?
//
// Con el navegador se capturó (relevarF29Rpc.ts): el PDF del formulario compacto
// es un GET a `rfiInternet/formCompacto?folio=&rut=&form=029&codInt=`, y la
// lista de declaraciones de un período sale de una llamada GWT-RPC
// (`svcConsulta` / `getFoliosConsulta`) cuyo cuerpo es texto serializado con el
// RUT y el período codificados como longs en el base64 de GWT (alfabeto
// A-Za-z0-9$_): `Eh_hw` = 76019824, `xdp` = 202601. Acá se prueba (1) el GET del
// PDF con el cookie jar de la sesión, con y sin `codInt`; (2) la replay del
// cuerpo capturado tal cual; (3) la misma replay con OTRO período.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-f29-http';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mercado') as NombrePerfil;
const CAPTURA = process.env.RELEVO_CAPTURA; // ruta a la captura de relevarF29Rpc.ts
const PERIODO_ALTERNATIVO = process.env.RELEVO_PERIODO ?? '202507';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_';
export function longGwt(n: number): string {
  if (n === 0) return 'A';
  let s = '';
  let v = n;
  while (v > 0) { s = ALFABETO[v % 64] + s; v = Math.floor(v / 64); }
  return s;
}
export function deLongGwt(s: string): number {
  let v = 0;
  for (const ch of s) v = v * 64 + ALFABETO.indexOf(ch);
  return v;
}

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

  console.log(`decodificación: Eh_hw=${deLongGwt('Eh_hw')} xdp=${deLongGwt('xdp')} tcaQa=${deLongGwt('tcaQa')} WFX5y=${deLongGwt('WFX5y')} C5Z20=${deLongGwt('C5Z20')} IOFT3a=${deLongGwt('IOFT3a')}`);
  console.log(`codificación: 76019824=${longGwt(76019824)} 202601=${longGwt(202601)} ${PERIODO_ALTERNATIVO}=${longGwt(Number(PERIODO_ALTERNATIVO))}`);

  if (!CAPTURA) { console.log('Pasá RELEVO_CAPTURA con la ruta al JSON de relevarF29Rpc.ts'); return; }
  const capturas = JSON.parse(fs.readFileSync(CAPTURA, 'utf8')) as { url: string; body: string; headers: Record<string, string> }[];
  const folios = capturas.find(c => (c.body ?? '').includes('getFoliosConsulta'));
  if (!folios) throw new Error('la captura no trae getFoliosConsulta');

  await registro.ejecutar(p.rut, async sesion => {
    const jar = await sesion.rutaCookieJar();
    const curl = (args: string[]) => execFileSync('curl', ['-sk', '-b', jar, '-c', jar, '--max-time', '40', '-A', UA, ...args], { encoding: 'latin1', maxBuffer: 50 * 1024 * 1024 });
    const pausa = () => new Promise(r => setTimeout(r, pausaConfigurada()));

    console.log('\n1. PDF compacto por GET con el cookie jar');
    // Sin pasar antes por la SPA: si hace falta el contexto de sesión de la app,
    // acá se ve.
    const pdfBase = process.env.RELEVO_PDF_URL; // formCompacto?folio=&rut=&form=029&codInt=
    for (const [n, url] of (pdfBase ? [
      ['con codInt', pdfBase],
      ['sin codInt', pdfBase.replace(/&codInt=.*/, '')],
    ] : []) as [string, string][]) {
      await pausa();
      const out = curl(['-o', path.join(SALIDA, `compacto-${n.replace(/ /g, '-')}.bin`), '-w', '%{http_code} %{content_type} %{size_download} -> %{redirect_url}', url]);
      const firma = fs.readFileSync(path.join(SALIDA, `compacto-${n.replace(/ /g, '-')}.bin`)).subarray(0, 5).toString('latin1');
      console.log(`   ${n.padEnd(11)} ${out}  firma=${JSON.stringify(firma)}`);
    }

    console.log('\n2. Replay GWT-RPC de getFoliosConsulta, cuerpo capturado tal cual');
    const headers = folios.headers;
    const post = (body: string, nombre: string) => {
      const out = curl([
        '-H', `Content-Type: ${headers['Content-Type']}`, '-H', `X-GWT-Permutation: ${headers['X-GWT-Permutation']}`,
        '-H', `X-GWT-Module-Base: ${headers['X-GWT-Module-Base']}`, '-H', 'Referer: https://www4.sii.cl/sifmConsultaInternet/index.html?dest=cifxx&form=29',
        '--data-binary', body, '-w', '\n%{http_code}', folios.url,
      ]);
      const partes = out.split('\n');
      const status = partes.pop();
      const resp = partes.join('\n');
      fs.writeFileSync(path.join(SALIDA, `${nombre}.txt`), resp, 'latin1');
      console.log(`   ${nombre}: HTTP ${status}, ${resp.length} bytes: ${resp.replace(/\s+/g, ' ').slice(0, 500)}`);
      return resp;
    };
    await pausa();
    post(folios.body, 'replay-tal-cual');

    console.log(`\n3. Misma replay con período ${PERIODO_ALTERNATIVO}`);
    const otro = folios.body.replace(/\|xdp\|/, `|${longGwt(Number(PERIODO_ALTERNATIVO))}|`);
    await pausa();
    post(otro, 'replay-otro-periodo');
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
