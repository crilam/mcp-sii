import 'dotenv/config';
import * as fs from 'fs';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { pausaConfigurada } from '../ritmoSii';

// Releva la cadena de emisión de BHE (pasos 1 y 2) usando la MISMA
// infraestructura que la lectura de BHE que ya funciona (SiiHttpClient + sesión
// por clave, que loguea con el navegador y comparte el jar): bhe.ts consulta
// loa.sii.cl así hace semanas. NO ejecuta el paso 3 (valida) ni el 4 (emite).
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-bhe-emision';
const BASE = 'https://loa.sii.cl/cgi_IMT';

async function main() {
  fs.mkdirSync(SALIDA, { recursive: true });
  // RELEVO_RUT/RELEVO_CLAVE eligen la credencial; default el titular (SII_RUT).
  const rut = process.env.RELEVO_RUT ?? process.env.SII_RUT!;
  const clave = process.env.RELEVO_CLAVE_VAR ? process.env[process.env.RELEVO_CLAVE_VAR]! : process.env.SII_CLAVE!;
  const cred = new ProveedorCredencialesRuntime();
  cred.guardar(rut, clave);
  const registro = crearRegistroSesionesSii(cred);

  await registro.ejecutar(rut, async sesion => {
    const http = new SiiHttpClient(sesion);
    const dormir = () => new Promise(r => setTimeout(r, pausaConfigurada()));

    console.log(`Emisor ${rut}\n1. Paso 1: pantalla de tipo de retención (GET, no escribe)`);
    const h1 = await http.get(`${BASE}/TMBECN_ValidaTimbrajeContrib.cgi`, { modo: '1' });
    fs.writeFileSync(`${SALIDA}/paso1.html`, h1, 'latin1');
    const tieneRetencion = /OptTipoRetencion/.test(h1);
    console.log(`   ${h1.length} bytes; form de retención: ${tieneRetencion ? 'SÍ' : 'NO'}`);
    if (!tieneRetencion) {
      console.log(`   inicio: ${h1.replace(/\s+/g, ' ').slice(0, 300)}`);
      return;
    }

    console.log('\n2. Paso 2: formulario de datos (POST de la retención — carga el form, NO emite)');
    await dormir();
    const h2 = await http.postForm(`${BASE}/TMBECN_PresentaDatosBoleta.cgi`, {
      OptTipoRetencion: 'RETRECEPTOR',
    }, { charset: 'latin1' });
    fs.writeFileSync(`${SALIDA}/paso2.html`, h2, 'latin1');
    console.log(`   ${h2.length} bytes`);
    const inputs = [...h2.matchAll(/<(input|select|textarea)[^>]*>/gi)];
    const vistos = new Set<string>();
    console.log(`   ${inputs.length} controles; names:`);
    for (const m of inputs) {
      const name = /name=["']?([A-Za-z0-9_]+)/i.exec(m[0])?.[1];
      if (!name || vistos.has(name)) continue;
      vistos.add(name);
      const val = /value=["']([^"']*)/i.exec(m[0])?.[1] ?? '';
      const tipo = /type=["']?([a-z]+)/i.exec(m[0])?.[1] ?? m[1].toLowerCase();
      console.log(`     ${name} [${tipo}] = ${JSON.stringify(val).slice(0, 60)}`);
    }
    if (vistos.size === 0) console.log(`   inicio: ${h2.replace(/\s+/g, ' ').slice(0, 400)}`);
  });
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
