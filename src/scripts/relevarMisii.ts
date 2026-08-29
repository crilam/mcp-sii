import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';
import { SiiHttpClient } from '../http';
import { cerrarSesionSii } from '../cerrarSesionSii';
import { recorrerConRitmo } from '../ritmoSii';

// Releva QUÉ MUESTRA el portal privado sobre el propio contribuyente: la ficha
// de identidad tributaria que AgenticERP necesita para su pantalla de empresa
// (razón social, régimen, inicio de actividades, domicilio, representantes).
//
// Es la Fase 0 de la ronda 8 (`misii`). Sin esto hay que implementar a ciegas:
// un parser escrito de memoria produce campos plausibles y equivocados, que es
// el modo de falla más caro de este repositorio.
//
// El HTML crudo se guarda FUERA del repo (RELEVAR_SALIDA, por defecto el tmp
// del sistema): trae RUT y razón social reales, y los datos de terceros no se
// versionan. Los fixtures se anonimizan antes de entrar a tests/.
const SALIDA = process.env.RELEVAR_SALIDA ?? path.join(process.env.TMPDIR ?? '/tmp', 'relevar-misii');

// Páginas candidatas, en orden de interés. Todas son LECTURA: ninguna modifica
// el registro del contribuyente. Las `#` de las SPA no llegan al servidor, así
// que de esas se baja la raíz y lo que interesa es si sirven HTML con datos o
// sólo el shell de la aplicación.
const PAGINAS = [
  { nombre: 'misii-home', url: 'https://misiir.sii.cl/cgi_misii/siihome.cgi' },
  { nombre: 'datos-contribuyente', url: 'https://misiir.sii.cl/cgi_misii/siicont.cgi' },
  { nombre: 'regimenes-tributarios', url: 'https://www4.sii.cl/regimenesTributariosInternet/' },
  { nombre: 'timbraje', url: 'https://zeus.sii.cl/cvc/vdc/index.html' },
];

// Rótulos que el HTML de estas páginas usa para separar bloques. No se buscan
// campos concretos —eso sería asumir lo que queremos descubrir—: se listan los
// encabezados y las etiquetas que aparecen, para leerlos después.
function rotulos(html: string): string[] {
  const encontrados: string[] = [];
  const patrones = [
    /<h[1-4][^>]*>([\s\S]{2,90}?)<\/h[1-4]>/gi,
    /<t[hd][^>]*>\s*<(?:b|strong)>([\s\S]{2,90}?)<\/(?:b|strong)>/gi,
    /<(?:b|strong)>([\s\S]{2,90}?:)\s*<\/(?:b|strong)>/gi,
  ];
  for (const re of patrones) {
    for (const m of html.matchAll(re)) {
      const t = m[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (t && !encontrados.includes(t)) encontrados.push(t);
    }
  }
  return encontrados;
}

async function main() {
  const rut = process.env.SII_EMPRESA_RUT ?? process.env.SII_RUT;
  const clave = process.env.SII_EMPRESA_CLAVE ?? process.env.SII_CLAVE;
  if (!rut || !clave) throw new Error('Faltan SII_EMPRESA_RUT/SII_EMPRESA_CLAVE en el entorno.');

  fs.mkdirSync(SALIDA, { recursive: true });
  const sesion = new SessionManager(
    { rut, clave, strategy: AuthStrategy.Clave }, new Browser(`relevar-misii-${Date.now()}`));

  try {
    const http = new SiiHttpClient(sesion);
    // `authenticateOnly` y no `getSession`: estas páginas cuelgan de la
    // identidad autenticada, no del contribuyente seleccionado en mipyme.
    // Pasar por la selección de empresa acá sólo agrega un paso que puede
    // fallar (y falla) sin aportar nada a la ficha.
    await sesion.authenticateOnly();
    console.log(`sesion abierta para ${rut}\nsalida: ${SALIDA}\n`);

    // Con ritmo: son cuatro páginas seguidas del mismo portal, y el SII corta
    // por volumen y por patrón (ver `ritmoSii.ts`).
    await recorrerConRitmo(PAGINAS, async ({ nombre, url }) => {
      try {
        const html = await http.get(url);
        fs.writeFileSync(path.join(SALIDA, `${nombre}.html`), html);
        const rs = rotulos(html);
        console.log(`${nombre.padEnd(24)} ${String(html.length).padStart(7)} bytes  ${rs.length} rótulos`);
        for (const r of rs.slice(0, 25)) console.log(`    · ${r}`);
        if (rs.length > 25) console.log(`    … y ${rs.length - 25} más (ver el .html)`);
        console.log('');
      } catch (e) {
        console.log(`${nombre.padEnd(24)} FALLA  ${(e as Error).message.slice(0, 90)}\n`);
      }
    });
  } finally {
    await cerrarSesionSii(sesion);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
