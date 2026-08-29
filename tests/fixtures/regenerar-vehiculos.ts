// Reescribe las fixtures XLSX de vehículos con ExcelJS.
//
// Las fixtures se fabricaron con openpyxl, y el lector en STREAMING de ExcelJS
// sólo veía la primera hoja de esos archivos (y sin nombre): openpyxl ordena
// las entradas del zip distinto de como el lector las espera. El libro real del
// SII sí se lee entero. Reescribirlas con ExcelJS deja el zip en el orden que
// el lector entiende, con el mismo contenido.
//
//   npx ts-node tests/fixtures/regenerar-vehiculos.ts
import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';

async function reescribir(nombre: string): Promise<void> {
  const ruta = path.join(__dirname, nombre);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(fs.readFileSync(ruta) as unknown as ExcelJS.Buffer);
  const salida = new ExcelJS.Workbook();
  for (const hoja of wb.worksheets) {
    const nueva = salida.addWorksheet(hoja.name);
    hoja.eachRow({ includeEmpty: true }, (fila, n) => {
      fila.eachCell({ includeEmpty: false }, (celda, col) => {
        nueva.getCell(n, col).value = celda.value;
      });
    });
  }
  await salida.xlsx.writeFile(ruta);
  console.log(`${nombre}: ${wb.worksheets.map(h => `${h.name} (${h.rowCount} filas)`).join(', ')}`);
}

(async () => {
  for (const n of ['vehiculos-liv.xlsx', 'vehiculos-pes.xlsx', 'vehiculos-formato-desconocido.xlsx']) {
    await reescribir(n);
  }
})().catch(e => { console.error(e); process.exit(1); });
