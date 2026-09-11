import 'dotenv/config';
import { crearRegistroSesionesSii } from '../registroSesionesSii';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { registrarRutasF29 } from '../rest/rutas/f29';
import { RutaHandler } from '../rest/rutas/comun';
import { perfil, credencialParaBody, NombrePerfil } from '../perfilesVerificacion';
import { soloCuerpoRut } from '../scrapers/mipymeHttp';

// Verifica `POST /v1/f29/ppm` contra el SII real, por el handler REST.
//
// El criterio no es "responde ok": es que traiga la TASA (código 115) y que NO
// traiga el RUT del contribuyente, que el SII sí devuelve en esta respuesta.
//
// Es una consulta de SOLO LECTURA: `getTasaPPMO` no guarda ni declara nada.
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
  const r = await rutas.get('POST /v1/f29/ppm')!({
    ...credencialParaBody(p), rut: p.rut, periodo: PERIODO,
  });
  const b = r.body as Record<string, unknown>;

  if (b.ok !== true) {
    console.log(`respuesta: error=${b.error}`);
    return;
  }

  const casilleros = b.casilleros as { codigo: string; valor: string }[];
  // Los VALORES no se imprimen salvo la tasa: son montos reales del
  // contribuyente. Se muestra qué códigos vinieron, que es lo que hay que
  // verificar.
  console.log(`  ${casilleros.length} casilleros: ${casilleros.map(c => c.codigo).join(', ')}`);
  const tasa = casilleros.find(c => c.codigo === '115');
  console.log(`  tasa (115): ${tasa ? `${tasa.valor} (${typeof tasa.valor})` : 'AUSENTE'}`);
  console.log(`  tasa_idpc=${b.tasa_idpc} categoria_tributaria=${b.categoria_tributaria} es_propyme=${b.es_propyme}`);
  console.log(`  realizado=${b.realizado} fuera_de_plazo=${b.fuera_de_plazo} periodo=${b.periodo}`);
  console.log(`  generada_en: ${b.generada_en}`);

  const noString = casilleros.filter(c => typeof c.valor !== 'string');
  console.log(`  todos los valores son string: ${noString.length === 0 ? 'SÍ' : `NO — códigos ${noString.map(c => c.codigo).join(', ')}`}`);

  // Lo que NO debe estar. El SII devuelve `rutContribuyente` y `dv` en esta
  // respuesta; la ruta arma el cuerpo campo por campo para dejarlos afuera.
  //
  // Este script ASUME que `p.rut` viene en la forma "cuerpo-DV" (con o sin
  // puntos en el cuerpo), que es la forma con la que se cargan los perfiles de
  // verificación. No se tolera la forma sin guion, y es a propósito: si se
  // tolerara, un identificador sin guion pasa entero por `soloCuerpoRut` (que
  // sólo separa por el guion) y el "cuerpo" resultante queda con el dígito
  // verificador todavía pegado. La respuesta del SII trae el cuerpo SOLO, sin
  // DV, así que esa búsqueda no encuentra nada — ni siquiera si la ruta
  // filtrara mal — y el chequeo daría "SÍ, sin filtración" por vacuidad, que es
  // exactamente lo que este script existe para no hacer. Por eso se exige la
  // forma con guion y se falla ruidosamente si no la trae, en vez de intentar
  // adivinar el cuerpo de una forma que no se puede distinguir de un cuerpo
  // sin DV.
  const rutNormalizado = p.rut.trim().replace(/\./g, '');
  if (!/^\d{7,8}-[\dkK]$/.test(rutNormalizado)) {
    throw new Error(
      `el RUT del perfil '${NOMBRE}' es '${p.rut}' y no tiene la forma "cuerpo-DV" que este chequeo ` +
      `exige (ej. "12345678-9"). Sin el guion no se puede distinguir el cuerpo del dígito verificador, ` +
      `y buscar el cuerpo mal calculado deja el chequeo de filtración vacío — pasaría "sin filtración" ` +
      `aunque la ruta filtrara mal. Corregí el RUT del perfil '${NOMBRE}' en perfilesVerificacion.`
    );
  }
  const json = JSON.stringify(b);
  const rutSinFormato = soloCuerpoRut(p.rut);
  for (const [que, presente] of [
    ['rutContribuyente', json.includes('rutContribuyente')],
    ['el RUT en cualquier campo', json.includes(rutSinFormato)],
  ] as [string, boolean][]) {
    console.log(`  sin ${que}: ${presente ? 'NO — ¡FILTRACIÓN!' : 'SÍ'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
