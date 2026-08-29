import 'dotenv/config';
import * as fs from 'fs';
import { parsearPlanilla, planilla, CategoriaVehiculo } from '../scrapers/vehiculos';

// Verifica el parser de tasación de vehículos contra las planillas REALES del
// SII. Si se pasa una ruta local (`VERIF_XLSX=/ruta/liv2026.xlsx`) se parsea
// esa sin tocar la red; si no, se baja la del año pedido (UNA request, pública).
//
// El criterio no es "parsea": es que la cantidad de filas cuadre con la
// planilla y que los valores de una fila conocida sean los que se ven abriendo
// el archivo en una hoja de cálculo.
const ANIO = Number(process.argv[2] ?? 2026);
const CATEGORIA = (process.argv[3] ?? 'liviano') as CategoriaVehiculo;

async function main() {
  const t0 = Date.now();
  const p = process.env.VERIF_XLSX
    ? await parsearPlanilla(fs.readFileSync(process.env.VERIF_XLSX), ANIO, CATEGORIA)
    : await planilla(ANIO, CATEGORIA);
  console.log(`${CATEGORIA} ${ANIO}: ${p.filas.length} vehículos, ${p.equipamiento.length} siglas de equipamiento, ${Date.now() - t0} ms`);

  const marcas = new Set(p.filas.map(f => f.marca));
  const tipos = new Set(p.filas.map(f => f.tipo));
  console.log(`  ${marcas.size} marcas, ${tipos.size} tipos: ${[...tipos].slice(0, 12).join(', ')}`);
  console.log('  primera fila:', JSON.stringify(p.filas[0]));
  console.log('  última fila: ', JSON.stringify(p.filas[p.filas.length - 1]));

  const sinAnio = p.filas.filter(f => f.anioFabricacion === 0).length;
  const sinMarca = p.filas.filter(f => f.marca === '').length;
  console.log(`  sin año: ${sinAnio}, sin marca: ${sinMarca}, sin permiso: ${p.filas.filter(f => f.permiso === null).length}`);
  if (p.equipamiento.length) console.log('  equipamiento ej:', JSON.stringify(p.equipamiento.slice(0, 3)));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
