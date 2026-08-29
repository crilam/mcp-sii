import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasMipyme } from '../rest/rutas/mipyme';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';

// Verifica `list-dte-recibidos` contra el SII real, por el handler REST.
//
// Contrastar los VALORES y no sólo que responda: un parser de tablas que agarra
// la columna corrida devuelve documentos plausibles con el emisor equivocado.
const NOMBRE = (process.argv[2] ?? 'certificado') as NombrePerfil;

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasMipyme(rutas, registro, credenciales);
  const cred = credencialParaBody(p);

  const empresas = await rutas.get('POST /v1/mipyme/list-empresas')!({ ...cred });
  const lista = (empresas.body as { datos?: { rut: string; nombre: string }[] }).datos ?? [];
  console.log(`${lista.length} empresa(s) para ${p.rut}`);

  const empresa = process.env.VERIF_EMPRESA ?? lista[0]?.rut;
  if (!empresa) {
    console.log('Sin empresas: no hay nada que verificar.');
    return;
  }

  const r = await rutas.get('POST /v1/mipyme/list-dte-recibidos')!({
    ...cred, empresa_rut: empresa,
  });
  const b = r.body as Record<string, unknown>;

  if (b.ok !== true) {
    console.log(`FALLA  status=${r.status} error=${b.error} detalle=${String(b.detalle ?? '')}`);
    return;
  }

  const docs = b.documentos as Record<string, unknown>[];
  console.log(`\nempresa ${b.empresaRut}  página ${b.pagina} de ${b.totalPaginas ?? '?'}`);
  console.log(`${docs.length} documento(s) recibidos\n`);
  for (const d of docs.slice(0, 5)) console.log('  ', JSON.stringify(d));

  // Un tipo en 0 significa que el nombre del documento no está en el catálogo
  // del scraper. No es fatal, pero hay que verlo: el consumidor filtra por tipo.
  const sinTipo = docs.filter(d => d.tipoDte === 0);
  if (sinTipo.length > 0) {
    const nombres = [...new Set(sinTipo.map(d => d.tipoDteNombre))];
    console.log(`\n  ${sinTipo.length} documento(s) con tipoDte=0: ${nombres.join(', ')}`);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
