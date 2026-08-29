import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { SiiHttpClient } from '../http';
import { registrarRutasRcv } from '../rest/rutas/rcv';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';
import { pausaConfigurada } from '../ritmoSii';

// Releva las RESPUESTAS de los dos CGI de verificación de DTE con un documento
// real: se toma uno del RCV de compras del propio contribuyente (emisor,
// receptor, tipo, folio, fecha y monto conocidos) y se le pregunta al SII por su
// validez y por su contenido. Sin un documento real las respuestas no se pueden
// ver, y sin verlas no hay parser.
const SALIDA = process.env.RELEVO_SALIDA ?? '/tmp/relevo-verificar-dte';
const NOMBRE = (process.env.RELEVO_PERFIL ?? 'mercado') as NombrePerfil;
const PERIODO = process.env.RELEVO_PERIODO ?? '202507';

async function main() {
  const p = perfil(NOMBRE);
  fs.mkdirSync(SALIDA, { recursive: true });
  const credenciales = new ProveedorCredencialesRuntime();
  // Se registra la credencial ANTES: el handler REST usa un ejecutor que la
  // borra al terminar, y el `registro.ejecutar` de abajo la necesita otra vez.
  if (p.credencial.tipo === 'certificado') {
    credenciales.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
  } else {
    credenciales.guardar(p.rut, p.credencial.clave);
  }
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasRcv(rutas, registro, credenciales);
  const volverARegistrar = () => {
    if (p.credencial.tipo === 'certificado') {
      credenciales.guardarCertificado(p.rut, p.credencial.certificadoBase64, p.credencial.certificadoPassword, process.env.SII_CERT_CLAVE_SII);
    } else {
      credenciales.guardar(p.rut, p.credencial.clave);
    }
  };

  // Un documento de compra real: el receptor es el propio contribuyente.
  const r = await rutas.get('POST /v1/rcv/detalle')!({ ...credencialParaBody(p), periodo: PERIODO, operacion: 'COMPRA', tipo_doc: 33 });
  const b = r.body as { ok?: boolean; documentos?: Record<string, unknown>[]; detalle?: string };
  const doc = b.documentos?.[0];
  if (!doc) { console.log(`Sin documentos de compra en ${PERIODO}: ${b.detalle ?? ''}`); return; }
  console.log('Claves del documento:', Object.keys(doc).join(', '));
  const rutContraparte = String(doc.contraparteRut ?? '');
  console.log('Documento del RCV:', JSON.stringify({ emisor: rutContraparte, folio: doc.folio, fecha: doc.fechaEmision, total: doc.montoTotal, tipo: doc.tipoDoc }));
  const [rutEmisor, dvEmisor] = rutContraparte.replace(/\./g, '').split('-');
  const [rutRecep, dvRecep] = p.rut.replace(/\./g, '').split('-');
  const fecha = String(doc.fechaEmision ?? '').slice(0, 10); // dd/mm/aaaa
  const [dd, mm, aaaa] = fecha.split('/');

  volverARegistrar();
  await registro.ejecutar(p.rut, async sesion => {
    const http = new SiiHttpClient(sesion);
    const mostrar = (nombre: string, html: string) => {
      fs.writeFileSync(path.join(SALIDA, nombre), html, 'latin1');
      const texto = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' | ').replace(/(\s*\|\s*)+/g, ' | ').replace(/\s+/g, ' ');
      console.log(`\n== ${nombre} ${html.length} bytes\n   ${texto.slice(0, 900)}`);
    };

    // Abrir el formulario primero: deja la sesión del CGI armada.
    await http.get('https://palena.sii.cl/cgi_dte/UPL/DTEauth?2', undefined, { guardarCookies: true });
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    mostrar('validez.html', await http.postForm('https://palena.sii.cl/cgi_dte/UPL/QValidaDTE', {
      rutConsulta: rutRecep, dvConsulta: dvRecep, rutQuery: rutEmisor, dvQuery: dvEmisor,
      tipoDTE: String(doc.tipoDoc ?? 33), folioDTE: String(doc.folio),
    }, { charset: 'latin1' }));

    await new Promise(r => setTimeout(r, pausaConfigurada()));
    await http.get('https://palena.sii.cl/cgi_dte/UPL/DTEauth?6', undefined, { guardarCookies: true });
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    mostrar('contenido.html', await http.postForm('https://palena.sii.cl/cgi_dte/UPL/QEstadoDTE', {
      rutQuery: rutRecep, dvQuery: dvRecep, rutCompany: rutEmisor, dvCompany: dvEmisor,
      rutReceiver: rutRecep, dvReceiver: dvRecep, tipoDTE: String(doc.tipoDoc ?? 33),
      folioDTE: String(doc.folio), fechaDTE: `${dd}${mm}${aaaa}`, montoDTE: String(doc.montoTotal ?? ''),
    }, { charset: 'latin1' }));

    // Caso NEGATIVO: el mismo documento con el monto equivocado, para ver cómo
    // dice el CGI que los datos no coinciden. Sin esto el parser sólo conocería
    // la respuesta feliz.
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    mostrar('contenido-mal.html', await http.postForm('https://palena.sii.cl/cgi_dte/UPL/QEstadoDTE', {
      rutQuery: rutRecep, dvQuery: dvRecep, rutCompany: rutEmisor, dvCompany: dvEmisor,
      rutReceiver: rutRecep, dvReceiver: dvRecep, tipoDTE: String(doc.tipoDoc ?? 33),
      folioDTE: String(doc.folio), fechaDTE: `${dd}${mm}${aaaa}`, montoDTE: String(Number(doc.montoTotal ?? 0) + 1),
    }, { charset: 'latin1' }));
    // Y un folio que no existe, para la validez.
    await new Promise(r => setTimeout(r, pausaConfigurada()));
    mostrar('validez-mal.html', await http.postForm('https://palena.sii.cl/cgi_dte/UPL/QValidaDTE', {
      rutConsulta: rutRecep, dvConsulta: dvRecep, rutQuery: rutEmisor, dvQuery: dvEmisor,
      tipoDTE: String(doc.tipoDoc ?? 33), folioDTE: '99999999',
    }, { charset: 'latin1' }));
  });
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
