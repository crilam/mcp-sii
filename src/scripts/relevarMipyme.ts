import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { pausaConfigurada } from '../ritmoSii';
import { perfil, NombrePerfil } from '../perfilesVerificacion';

// Releva el portal mipyme: qué CGI ofrece el menú una vez seleccionada la
// empresa, y qué formularios expone cada uno.
//
// NO se adivinan nombres de CGI. En la ronda 1 se probaron cuatro nombres
// "obvios" para los métodos del RCV y fallaron los cuatro; lo que funcionó fue
// leer lo que el portal declara. Acá vale lo mismo: `mipeAdminDocsEmi.cgi` es el
// historial de emitidos, y suena a que recibidos sería `...Rec.cgi`, pero eso es
// una corazonada, no un dato.
//
// Va con ritmo y con tope: el SII bloquea por patrón de uso, y quedarse sin el
// portal mipyme deja al SERVICIO sin poder consultarlo para los tenants reales.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-mipyme';
const CGI_BASE = 'https://www1.sii.cl/cgi-bin/Portal001';
const SEL_EMPRESA_URL = `${CGI_BASE}/mipeSelEmpresa.cgi`;

// Tope duro de PEDIDOS al SII en una corrida. Un relevamiento sin tope es
// exactamente el barrido que bloqueó el RCV.
//
// Cuenta todos los pedidos y no sólo los que guardan una página: una primera
// versión sólo contaba los de `bajar()`, así que los POST de selección y el
// salto del launcher quedaban afuera y el tope real era mayor que el declarado —
// justo el tipo de discrepancia que hace inútil un tope.
const TOPE_PEDIDOS = Number(process.env.RELEVO_TOPE ?? 12);

function enlacesDe(html: string): { href: string; texto: string }[] {
  const salida: { href: string; texto: string }[] = [];
  for (const m of html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const texto = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
    salida.push({ href: m[1], texto });
  }
  return salida;
}

// Las empresas del portal viven en `<option value="RUT">`, no en enlaces. Una
// primera versión contaba `<a>` y reportaba "0 empresas" con las cinco delante:
// el portal estaba bien y el relevamiento medía otra cosa.
function empresasDe(html: string): { rut: string; nombre: string }[] {
  return [...html.matchAll(/<option\s+value=["']([^"']+)["'][^>]*>([^<]*)/gi)]
    .map(m => ({ rut: m[1].trim(), nombre: m[2].replace(/\s+/g, ' ').trim() }))
    .filter(e => /^\d+-[\dkK]$/.test(e.rut));
}

function formulariosDe(html: string): string[] {
  return [...html.matchAll(/<form[^>]*>/gi)].map(m => m[0]);
}

async function main() {
  // Por defecto el perfil del certificado: es el que tiene empresas en
  // Facturación Gratuita. Con un RUT que no esté inscrito, el selector del
  // portal vuelve vacío y no hay nada que relevar.
  const nombre = (process.argv[2] ?? 'certificado') as NombrePerfil;
  const p = perfil(nombre);

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
  const rut = p.rut;
  console.log(`Relevando con el perfil ${nombre} (${rut}, ${p.credencial.tipo}).\n`);

  // `ejecutar` es el mismo camino que usan las rutas: encola por RUT y cierra la
  // sesión al terminar. Un relevamiento que abriera la sesión a mano le comería
  // el cupo de sesiones simultáneas a los tenants reales si algo fallara.
  await registro.ejecutar(rut, async sesion => {
    const http = new SiiHttpClient(sesion);
    let pedidos = 0;

    // Todo pedido al SII pasa por acá, guarde o no la respuesta: es lo que hace
    // que el tope sea el tope.
    const contar = () => {
      pedidos++;
      if (pedidos > TOPE_PEDIDOS) {
        throw new Error(
          `Se alcanzó el tope de ${TOPE_PEDIDOS} pedidos al SII. Subilo con `
          + 'RELEVO_TOPE si de verdad hace falta, sabiendo que un barrido largo '
          + 'deja al servicio sin el portal para los tenants reales.');
      }
    };

    const bajar = async (url: string, nombre: string, params?: Record<string, string>) => {
      if (pedidos >= TOPE_PEDIDOS) {
        console.log(`  TOPE alcanzado (${TOPE_PEDIDOS}); no se baja ${nombre}.`);
        return null;
      }
      contar();
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const html = await http.get(url, params);
      fs.writeFileSync(path.join(SALIDA, `${nombre}.html`), html, 'latin1');
      console.log(`  ${nombre.padEnd(28)} ${html.length} bytes`);
      return html;
    };

    console.log('1. Selección de empresa');
    const selector = await bajar(SEL_EMPRESA_URL, 'sel-empresa');
    if (!selector) return;

    const empresas = empresasDe(selector);
    console.log(`  ${empresas.length} empresa(s) disponibles:`);
    for (const e of empresas) console.log(`    ${e.rut.padEnd(12)} ${e.nombre}`);

    // La empresa a activar es una de las del selector, NO el RUT con que se
    // autenticó: ese es el de la persona natural que las opera. Mandarlo hacía
    // que el portal devolviera otra vez el selector, sin error visible.
    const empresa = process.env.RELEVO_EMPRESA ?? empresas[0]?.rut;
    if (!empresa) {
      console.log('  Sin empresas en el portal: no hay nada que relevar.');
      return;
    }

    console.log(`\n2. Menú del portal con ${empresa} activa`);
    contar();
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    let menu = await http.postForm(SEL_EMPRESA_URL, { RUT_EMP: empresa });
    fs.writeFileSync(path.join(SALIDA, 'menu.html'), menu, 'latin1');

    // El POST de selección NO devuelve el menú: devuelve 681 bytes de HTML con un
    // `window.location.replace(...)` en un onLoad. Un navegador lo sigue solo; un
    // cliente HTTP se queda con la página vacía y parece que el portal no tuviera
    // menú. Se sigue el salto a mano.
    const salto = /window\.location\.replace\(\s*url_host\s*\)/.test(menu)
      ? (/url_host\s*=\s*"(\/factura_sii[^"]+)"/.exec(menu)?.[1] ?? null)
      : null;
    if (salto) {
      console.log(`  el POST redirige por JS a ${salto}; se sigue`);
      contar();
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const real = await http.get(`https://www1.sii.cl${salto}`);
      fs.writeFileSync(path.join(SALIDA, 'menu.html'), real, 'latin1');
      menu = real;
    }

    const enlaces = enlacesDe(menu).filter(e => /\.cgi|\.html?/i.test(e.href));
    console.log(`  ${enlaces.length} enlaces en el menú:`);
    for (const e of enlaces) {
      console.log(`    ${e.href.slice(0, 60).padEnd(62)} ${e.texto.slice(0, 46)}`);
    }
    fs.writeFileSync(
      path.join(SALIDA, 'enlaces.json'), JSON.stringify(enlaces, null, 2));

    console.log(`\n  formularios del menú: ${formulariosDe(menu).length}`);
    for (const f of formulariosDe(menu)) console.log(`    ${f.slice(0, 120)}`);

    // El menú no lleva a los CGI: lleva a `mipeLaunchPage.cgi?OPCION=N`, que es
    // el enrutador del portal. Lo que interesa de cada opción es a QUÉ CGI
    // termina llevando y qué formulario expone, porque ese CGI es el que va a
    // consultar el scraper.
    console.log('\n3. Opciones del menú que faltan homologar');
    const OPCIONES: { opcion: string; que: string }[] = [
      { opcion: '1', que: 'documentos recibidos' },
      { opcion: '103', que: 'propuesta F29' },
    ];

    for (const { opcion, que } of OPCIONES) {
      const html = await bajar(
        `${CGI_BASE}/mipeLaunchPage.cgi`, `opcion-${opcion}`,
        { OPCION: opcion, TIPO: '4' });
      if (!html) break;

      console.log(`  OPCION=${opcion} (${que})`);
      for (const f of formulariosDe(html)) {
        const accion = /action=["']([^"']+)["']/i.exec(f)?.[1] ?? '(sin action)';
        const nombre = /name=["']([^"']+)["']/i.exec(f)?.[1] ?? '';
        console.log(`    form ${nombre.padEnd(18)} -> ${accion}`);
      }
      const campos = [...html.matchAll(/<(?:input|select)[^>]*name=["']([^"']+)["']/gi)]
        .map(m => m[1]);
      if (campos.length > 0) {
        console.log(`    campos: ${[...new Set(campos)].join(', ').slice(0, 200)}`);
      }
      // El launcher tampoco es la página: asigna `window.location.href` al CGI
      // de verdad. Es el dato que se vino a buscar — el nombre del CGI y sus
      // parámetros, que no se adivinan (recibidos es `...Rcp.cgi`, no `...Rec`).
      const destino = /window\.location\.href\s*=\s*"([^"]+)"/.exec(html)?.[1];
      if (!destino) continue;
      console.log(`    -> ${destino}`);

      const url = new URL(destino, 'https://www1.sii.cl');
      const params = [...url.searchParams.keys()];
      if (params.length > 0) console.log(`    params: ${params.join(', ')}`);

      const pagina = await bajar(url.origin + url.pathname, `cgi-opcion-${opcion}`,
        Object.fromEntries(url.searchParams));
      if (!pagina) break;

      const tablas = pagina.split(/<table/i).length - 1;
      const filas = pagina.split(/<tr/i).length - 1;
      console.log(`    la página trae ${tablas} tabla(s) y ${filas} fila(s)`);
    }

    console.log(`\nHTML guardado en ${SALIDA}. Pedidos al SII: ${pedidos} de ${TOPE_PEDIDOS}.`);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
