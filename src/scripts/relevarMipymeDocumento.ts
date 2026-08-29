import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { MipymeHttpScraper } from '../scrapers/mipymeHttp';
import { perfil, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Releva la página de UN documento recibido (`mipeGesDocRcp.cgi?CODIGO=...`).
//
// Es la que hay que leer para el PDF y el XML de un documento: los CGI que
// aparecen en el listado —`mipeDownLoad.cgi` y `mipeImprimeDocAdm.cgi`— son
// descargas MASIVAS del listado filtrado, no de un documento, y además las
// dispara un reCAPTCHA (`llamaRecaptchaConCallback('key_download', ...)`), o sea
// que no son un camino que un servicio pueda recorrer solo.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-mipyme-doc';
const CGI_BASE = 'https://www1.sii.cl/cgi-bin/Portal001';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'certificado') as NombrePerfil;

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
    const scraper = new MipymeHttpScraper(http, sesion);

    // Se toma un documento REAL del listado en vez de recibir un CODIGO por
    // parámetro: así el relevamiento no depende de que alguien pegue un código
    // a mano, y de paso comprueba que el código que publica el listado es el
    // que esta página acepta.
    const empresa = process.env.RELEVO_EMPRESA;
    const listado = await scraper.listDteRecibidos({ empresaRut: empresa });
    const doc = listado.documentos[0];
    if (!doc) {
      console.log('El listado vino vacío: no hay documento que relevar.');
      return;
    }
    console.log(
      `Documento: ${doc.tipoDteNombre} folio ${doc.folio} de ${doc.emisorRut}, `
      + `codigo ${doc.codigo}\n`);

    // La empresa activa es estado del SERVIDOR y `listDteRecibidos` la dejó
    // seleccionada dentro de su propia sección crítica. Se vuelve a seleccionar
    // acá porque este GET va fuera de ella, y sin la selección el CGI responde
    // "Su requerimiento no ha sido bien recepcionado" — un error genérico que
    // manda a revisar el navegador cuando lo que falta es el contexto.
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    const empresas = await scraper.listEmpresas();
    const activa = empresa ?? empresas[0].rut;
    await http.postForm(`${CGI_BASE}/mipeSelEmpresa.cgi`, { RUT_EMP: activa });

    await new Promise(r => setTimeout(r, pausaConfigurada()));
    // `ALL_PAGE_ANT` va porque el enlace del listado lo lleva: es la página de
    // la que se viene, y el CGI puede estar usándola como contexto.
    const html = await http.get(
      `${CGI_BASE}/mipeGesDocRcp.cgi`, { CODIGO: doc.codigo, ALL_PAGE_ANT: '2' });
    fs.writeFileSync(path.join(SALIDA, 'documento.html'), html, 'latin1');
    console.log(`mipeGesDocRcp.cgi -> ${html.length} bytes`);

    const cgis = [...new Set([...html.matchAll(/([A-Za-z0-9_]+\.cgi)/g)].map(m => m[1]))];
    console.log(`\nCGI que ofrece la página: ${cgis.join(', ')}`);

    console.log('\nEnlaces y botones:');
    for (const m of html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const texto = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').trim();
      const alt = /alt=["']([^"']+)["']/i.exec(m[2])?.[1] ?? '';
      console.log(`  ${m[1].slice(0, 78).padEnd(80)} ${(texto || alt).slice(0, 40)}`);
    }

    console.log('\nDestinos asignados por JavaScript:');
    for (const m of html.matchAll(/(?:window\.location(?:\.href)?|urldata)\s*=\s*["']([^"']+)["']/gi)) {
      console.log(`  ${m[1].slice(0, 110)}`);
    }

    console.log('\nFormularios:');
    for (const m of html.matchAll(/<form[^>]*>/gi)) console.log(`  ${m[0].slice(0, 130)}`);

    // El reCAPTCHA es lo que decide si un camino es automatizable: si la
    // descarga de un documento también lo pide, no alcanza con saber el CGI.
    const recaptcha = [...html.matchAll(/llamaRecaptchaConCallback\(\s*'([^']+)'/g)].map(m => m[1]);
    console.log(`\nreCAPTCHA en la página: ${recaptcha.length > 0 ? recaptcha.join(', ') : 'no'}`);
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
