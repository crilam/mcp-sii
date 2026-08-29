import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { MipymeHttpScraper } from '../scrapers/mipymeHttp';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Releva, con sesión, dos cosas de la ronda 10 y del cierre de la 2:
//
//  1. La verificación de un DTE. Era pública y el SII la puso detrás del login:
//     `palena.sii.cl/cgi_dte/UPL/DTEauth?2` ("consultar validez") y `?6`
//     ("verificar contenido") redirigen a IngresoRutClave. Con sesión tienen que
//     servir el formulario, y sus campos son lo que hay que ver.
//  2. El XML de un DTE emitido en mipyme: la página de gestión del documento
//     EMITIDO (`mipeGesDocEmi.cgi`) puede ofrecer lo que la de recibidos no
//     ofrecía. apigateway expone `emitidos/xml`, así que algún camino hay.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-dte';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'certificado') as NombrePerfil;
const EMPRESA = process.env.RELEVO_EMPRESA;
const TOPE = Number(process.env.RELEVO_TOPE ?? 10);

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
    let pedidos = 0;
    const bajar = async (url: string, nombre: string, params?: Record<string, string>) => {
      if (++pedidos > TOPE) throw new Error(`Tope de ${TOPE} pedidos.`);
      await new Promise(r => setTimeout(r, pausaConfigurada()));
      const html = await http.get(url, params, { guardarCookies: true });
      fs.writeFileSync(path.join(SALIDA, nombre), html, 'latin1');
      console.log(`  ${nombre.padEnd(26)} ${html.length} bytes`);
      return html;
    };
    const resumen = (html: string) => {
      const salto = /(?:location(?:\.href)?\s*=|replace\()\s*["']([^"']+)["']/.exec(html)?.[1];
      if (salto) console.log(`   salta a: ${salto}`);
      for (const f of html.matchAll(/<form[^>]*>/gi)) console.log(`   ${f[0].slice(0, 150)}`);
      const campos = [...new Set([...html.matchAll(/<(?:input|select)[^>]*name=["']([^"']+)["'][^>]*>/gi)].map(m => m[0].slice(0, 110)))];
      for (const c of campos.slice(0, 25)) console.log(`     ${c}`);
      const cgis = [...new Set(html.match(/[A-Za-z0-9_]+\.cgi[^"'\s<>]*/g) ?? [])];
      if (cgis.length) console.log(`   cgi: ${cgis.slice(0, 15).join(' | ')}`);
      const texto = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      console.log(`   texto: ${texto.slice(0, 350)}`);
    };

    console.log(`Perfil ${NOMBRE} (${p.rut})\n1. Verificación de DTE`);
    for (const [n, url] of [['validez', 'https://palena.sii.cl/cgi_dte/UPL/DTEauth?2'], ['contenido', 'https://palena.sii.cl/cgi_dte/UPL/DTEauth?6']] as const) {
      console.log(`\n== ${n}: ${url}`);
      resumen(await bajar(url, `dte-${n}.html`));
    }

    console.log('\n2. XML de un DTE emitido en mipyme');
    const scraper = new MipymeHttpScraper(http, sesion);
    const emitidos = await scraper.listDteEmitidos({ empresaRut: EMPRESA });
    pedidos += 3;
    const doc = emitidos.documentos[0];
    if (!doc) { console.log('   sin documentos emitidos'); return; }
    console.log(`   documento ${doc.tipoDteNombre} folio ${doc.folio} codigo ${doc.codigo}`);
    // Volver a seleccionar la empresa: el GET va fuera de la sección crítica.
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    await http.postForm('https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi', { RUT_EMP: emitidos.empresaRut });
    const ges = await bajar('https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocEmi.cgi', 'mipe-ges-emi.html', { CODIGO: doc.codigo, ALL_PAGE_ANT: '2' });
    const enlaces = [...ges.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(m => ({ href: m[1], texto: m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim() }));
    for (const e of enlaces) console.log(`   ${e.href.slice(0, 90).padEnd(92)} ${e.texto.slice(0, 40)}`);
    console.log(`\nPedidos: ${pedidos} de ${TOPE}.`);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
