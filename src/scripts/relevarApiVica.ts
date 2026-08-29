import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { execFileSync } from 'child_process';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Sondea la API REST del portal de bienes raíces (`/app/vica/{rut-dv}/v1/...`)
// con una sesión real, para ver la FORMA de cada respuesta antes de escribir
// parsers. Las rutas salieron del bundle de la SPA; lo que el bundle no dice es
// qué campos devuelve cada una, y eso sólo se ve pidiéndolas.
//
// Con ritmo y tope: el SII cuenta por patrón de uso.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-vica';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'certificado') as NombrePerfil;
const TOPE = Number(process.env.RELEVO_TOPE ?? 8);
const HOST = 'https://www2.sii.cl';

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
    const jar = await sesion.rutaCookieJar();
    // La base lleva el RUT con guion y DV, tal como lo arma la SPA a partir de
    // la sesión: `/app/vica/{rut-dv}/v1`.
    const base = `${HOST}/app/vica/${p.rut.replace(/\./g, '')}/v1`;
    const entrada = `${HOST}/vica/Menu/BienesRaices`;
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    let pedidos = 0;

    const curl = (url: string, params?: Record<string, string>) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      // `-c jar`: el handshake de la SPA deja una cookie del contexto /app, y sin
      // ella la API responde 0 bytes. La primera sonda no la escribía y por eso
      // seis rutas correctas parecieron no existir.
      return execFileSync('curl', [
        '-sk', '-b', jar, '-c', jar, '-L', '--max-time', '25', '-A', UA,
        '-H', 'Accept: application/json', url + qs,
      ], { encoding: 'latin1', maxBuffer: 50 * 1024 * 1024 });
    };

    const pedir = async (ruta: string, params?: Record<string, string>) => {
      if (++pedidos > TOPE) throw new Error(`Tope de ${TOPE} pedidos.`);
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const crudo = curl(`${base}${ruta}`, params);
      const nombre = ruta.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') + '.json';
      fs.writeFileSync(path.join(SALIDA, nombre), crudo, 'latin1');
      let json: unknown = null;
      try { json = JSON.parse(crudo); } catch { /* HTML: se muestra el inicio */ }
      console.log(`\n${ruta}  ${crudo.length} bytes${json === null ? '  (NO es JSON)' : ''}`);
      if (json === null) {
        console.log('  ' + crudo.replace(/\s+/g, ' ').slice(0, 300));
        return null;
      }
      const j = json as Record<string, unknown>;
      console.log(`  claves: ${Object.keys(j).join(', ')}`);
      const cuerpo = (j.data ?? j.body ?? j) as unknown;
      if (Array.isArray(cuerpo)) {
        console.log(`  lista de ${cuerpo.length}; primer elemento:`);
        console.log('  ' + JSON.stringify(cuerpo[0]).slice(0, 700));
      } else if (cuerpo && typeof cuerpo === 'object') {
        console.log('  ' + JSON.stringify(cuerpo).slice(0, 700));
      }
      return json;
    };

    // Handshake de la SPA: index y estado de sesión, en ese orden.
    pedidos += 2;
    curl(entrada);
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    curl(`${HOST}/app/session/status`, { originalUrl: entrada });

    console.log(`Perfil ${NOMBRE} (${p.rut}), base ${base}`);
    const cabecera = await pedir('/mis-bbrr/obtener/cabecera');
    const propiedades = await pedir('/mis-bbrr/get/by-rut');
    await pedir('/comuna/obtener/comunas');
    await pedir('/periodo/get/actual');
    await pedir('/obtener/solicitudes');
    await pedir('/institucion/get/all');

    // Con una propiedad real se prueba la búsqueda por rol y los copropietarios.
    const lista = ((propiedades as Record<string, unknown> | null)?.data
      ?? (propiedades as Record<string, unknown> | null)?.body ?? propiedades) as Record<string, unknown>[] | null;
    const primera = Array.isArray(lista) ? lista[0] : null;
    if (primera) {
      const comuna = String(primera.comunaCnp ?? primera.comuna ?? '');
      const manzana = String(primera.manzanaCnp ?? primera.manzana ?? '');
      const predio = String(primera.predioCnp ?? primera.predio ?? '');
      console.log(`\nPrimera propiedad: comuna=${comuna} manzana=${manzana} predio=${predio}`);
      if (comuna && manzana && predio) {
        await pedir('/multipropietarios/get/by-rol', { comuna, manzana, predio });
      }
    }
    void cabecera;
    console.log(`\nPedidos: ${pedidos} de ${TOPE}. JSON en ${SALIDA}`);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
