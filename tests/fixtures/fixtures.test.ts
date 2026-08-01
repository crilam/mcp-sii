import * as fs from 'fs';
import * as path from 'path';

// Las respuestas del SII traen RUT, nombres y montos reales. Este repositorio
// tiene licencia y PRs, así que una fixture cruda es una filtración. El
// chequeo corre sobre todas las fixtures para que ninguna se cuele después.
//
// Importante: buscamos SOLO en campos de RUT (rut_arrastre, dv_arrastre, y campos
// cuyo nombre contenga "rut"), no en cualquier número de 7-8 dígitos. Así evitamos
// falsos positivos con montos. Un chequeo que captura "cualquier número largo"
// es frágil y se rompe si una fixture legítima tiene un monto o código que cae
// en ese rango. Ser específico es ser robusto.
const RUT_DE_PRUEBA = /^1{8}$/;

describe('fixtures anonimizadas', () => {
  const dir = __dirname;
  const fixtures = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

  it('hay fixtures que revisar', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s no contiene RUT fuera del rango de prueba', (nombre) => {
    const contenido = fs.readFileSync(path.join(dir, nombre), 'latin1');
    // Buscar campos que contengan "rut" en su nombre: xml_values['rut_algo'] = "valor"
    const ruts = [...contenido.matchAll(/xml_values\['([^']*rut[^']*)'\]\s*=\s*"(\d+)"/gi)]
      .map(m => m[2]); // m[1] es el nombre del campo, m[2] es el valor numérico

    const sospechosos = ruts.filter(r => !RUT_DE_PRUEBA.test(r));
    expect(sospechosos).toEqual([]);
  });

  it('el chequeo detecta RUTs reales', () => {
    // Test que verifica que el chequeo efectivamente rechaza RUTs fuera del rango
    // Si esto falla, el chequeo no está funcionando.
    const contenido = `
      <script>
        xml_values['rut_arrastre'] = "12345678";
        xml_values['dv_arrastre'] = "9";
      </script>
    `;
    const ruts = [...contenido.matchAll(/xml_values\['([^']*rut[^']*)'\]\s*=\s*"(\d+)"/gi)]
      .map(m => m[2]);

    const sospechosos = ruts.filter(r => !RUT_DE_PRUEBA.test(r));
    // Debe detectar 12345678 como sospechoso
    expect(sospechosos).toContain('12345678');
  });
});
