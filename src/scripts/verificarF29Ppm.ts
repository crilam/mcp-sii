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
  // Este script exige que `p.rut` venga como "cuerpo-DV": sin el guion,
  // `soloCuerpoRut` no tiene nada que cortar y el "cuerpo" queda con el DV
  // pegado, algo que la respuesta del SII (sólo el cuerpo, sin DV) nunca va a
  // contener — el chequeo de abajo daría "sin filtración: SÍ" por vacuidad,
  // aunque la ruta filtrara mal. Por eso falla acá en vez de adivinar.
  const rutNormalizado = p.rut.trim().replace(/\./g, '');
  if (!/^\d{7,8}-[\dkK]$/.test(rutNormalizado)) {
    throw new Error(
      `el RUT del perfil '${NOMBRE}' es '${p.rut}' y no tiene la forma "cuerpo-DV" que este chequeo ` +
      `exige (ej. "12345678-9"). Corregí el RUT del perfil '${NOMBRE}' en perfilesVerificacion.`
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
