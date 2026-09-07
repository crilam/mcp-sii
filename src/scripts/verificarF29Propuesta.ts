import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasF29 } from '../rest/rutas/f29';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';

// Verifica `POST /v1/f29/propuesta` contra el SII real, por el handler REST.
//
// El criterio no es "responde ok": es que traiga CASILLEROS y que NO traiga lo
// que no debe salir de acá —la traza del cálculo lleva el RUT del contribuyente,
// y `listCodBase` su razón social y domicilio—.
//
// Un período YA DECLARADO sigue respondiendo la propuesta por HTTP, aunque la
// interfaz del portal corte antes: por eso se puede verificar sobre períodos
// cerrados sin tocar uno vivo.
//
//   VERIF_PERIODO  AAAAMM (default 202607)
const NOMBRE = (process.argv[2] ?? 'mipyme') as NombrePerfil;
const PERIODO = process.env.VERIF_PERIODO ?? '202607';

async function main() {
  const p = perfil(NOMBRE);
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales);
  const rutas = new Map<string, RutaHandler>();
  registrarRutasF29(rutas, registro, credenciales);

  console.log(`Perfil ${NOMBRE}, período ${PERIODO}`);
  const r = await rutas.get('POST /v1/f29/propuesta')!({
    ...credencialParaBody(p), rut: p.rut, periodo: PERIODO,
  });
  const b = r.body as Record<string, unknown>;

  if (b.ok !== true) {
    console.log(`respuesta: error=${b.error}${b.error === 'SIN_PROPUESTA' ? ' (el SII no arma propuesta para el período)' : ''}`);
    return;
  }

  const casilleros = b.casilleros as { codigo: string; valor: string }[];
  console.log(`  ${casilleros.length} casilleros, tipo_propuesta=${b.tipo_propuesta}`);
  console.log(`  ${casilleros.map(c => `${c.codigo}=${c.valor}`).join('  ')}`);
  console.log(`  fecha_creacion: ${b.fecha_creacion ?? '(sin declaración)'}`);
  console.log(`  complemento_detalle_dte=${b.complemento_detalle_dte} documentos_del_giro=${b.documentos_del_giro}`);
  console.log(`  generada_en: ${b.generada_en}`);

  // Los valores tienen que llegar como STRING: si alguien los convierte a número
  // en el camino, la tasa del código 115 ("0.125") se rompe o se trunca.
  const noString = casilleros.filter(c => typeof c.valor !== 'string');
  console.log(`  todos los valores son string: ${noString.length === 0 ? 'SÍ' : `NO — ${JSON.stringify(noString)}`}`);

  // Lo que NO debe estar. Se mira sobre el JSON serializado, que es exactamente
  // lo que viaja al consumidor.
  const json = JSON.stringify(b);
  for (const prohibido of ['traza', 'resultadoCalculoPP29', 'listCodBase', 'ppmo']) {
    console.log(`  sin "${prohibido}": ${json.includes(prohibido) ? 'NO — ¡FILTRACIÓN!' : 'SÍ'}`);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
