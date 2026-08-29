import 'dotenv/config';
import { execFileSync } from 'child_process';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Diagnóstico de la API vica: la sonda anterior recibió SEIS cuerpos de 0 bytes,
// y un cuerpo vacío no dice si fue 401, 403, 302 sin destino o un 200 vacío.
// Acá se mira el status y el redirect de cada paso, reproduciendo el orden en
// que la SPA los hace: index → /app/session/status → API.
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'certificado') as NombrePerfil;
const HOST = 'https://www2.sii.cl';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function main() {
  const p = perfil(NOMBRE);
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
    const jar = await sesion.rutaCookieJar();
    const base = `${HOST}/app/vica/${p.rut.replace(/\./g, '')}/v1`;
    const entrada = `${HOST}/vica/Menu/BienesRaices`;

    const sonda = (url: string, extra: string[] = []) => {
      // Sin -L: interesa ver el redirect, no seguirlo. Se escribe la cookie jar
      // para que un Set-Cookie del handshake quede para el paso siguiente.
      const out = execFileSync('curl', [
        '-sk', '-b', jar, '-c', jar, '--max-time', '25', '-A', UA,
        '-o', '/dev/null', '-w', '%{http_code} %{size_download} %{content_type} -> %{redirect_url}',
        ...extra, url,
      ], { encoding: 'utf8' });
      console.log(`  ${out}\n     ${url.replace(HOST, '')}`);
    };

    console.log(`Perfil ${NOMBRE} (${p.rut})`);
    sonda(entrada);
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    sonda(`${HOST}/app/session/status?originalUrl=${encodeURIComponent(entrada)}`,
      ['-H', 'Accept: application/json']);
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    sonda(`${base}/comuna/obtener/comunas`, ['-H', 'Accept: application/json']);
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    sonda(`${base}/mis-bbrr/obtener/cabecera`,
      ['-H', 'Accept: application/json', '-H', `Referer: ${entrada}`, '-H', 'X-Requested-With: XMLHttpRequest']);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
