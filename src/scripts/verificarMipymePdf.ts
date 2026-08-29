import 'dotenv/config';
import * as fs from 'fs';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';

// Verifica `dte-pdf` contra el SII real, por el handler REST.
//
// El criterio no es "responde ok": es que lo devuelto SEA un PDF. El portal
// contesta 200 con HTML cuando algo falla, así que un chequeo por status dejaría
// pasar una página de error convertida en base64.
const NOMBRE = (process.argv[2] ?? 'certificado') as NombrePerfil;
const SALIDA = process.env.VERIF_SALIDA;

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasMipyme(rutas, registro, credenciales);
  const cred = credencialParaBody(p);
  const empresa = process.env.VERIF_EMPRESA;

  const listado = await rutas.get('POST /v1/mipyme/list-dte-recibidos')!({
    ...cred, empresa_rut: empresa,
  });
  const cuerpo = listado.body as { ok?: boolean; documentos?: Record<string, string>[]; detalle?: string };
  if (cuerpo.ok !== true) {
    console.log(`No se pudo listar: ${cuerpo.detalle ?? ''}`);
    return;
  }
  const doc = cuerpo.documentos?.[0];
  if (!doc) {
    console.log('Listado vacío: no hay documento para pedir el PDF.');
    return;
  }
  console.log(`Documento ${doc.tipoDteNombre} folio ${doc.folio}, codigo ${doc.codigo}`);

  const r = await rutas.get('POST /v1/mipyme/dte-pdf')!({
    ...cred, empresa_rut: empresa, codigo: doc.codigo,
  });
  const b = r.body as Record<string, unknown>;

  if (b.ok !== true) {
    console.log(`FALLA  status=${r.status} error=${b.error} detalle=${String(b.detalle ?? '')}`);
    return;
  }

  const pdf = Buffer.from(b.pdf_base64 as string, 'base64');
  // La firma `%PDF-` es lo que separa un PDF de una página de error: sin esto,
  // un HTML de 17 KB pasaría por PDF y el consumidor lo descubriría al abrirlo.
  const esPdf = pdf.subarray(0, 5).toString('latin1') === '%PDF-';
  console.log(`  ${b.tamano_bytes} bytes, ${b.nombre_archivo}`);
  console.log(`  empieza con %PDF-: ${esPdf ? 'SÍ' : 'NO — ' + pdf.subarray(0, 80).toString('latin1')}`);

  if (SALIDA && esPdf) {
    fs.writeFileSync(SALIDA, pdf);
    console.log(`  guardado en ${SALIDA}`);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
