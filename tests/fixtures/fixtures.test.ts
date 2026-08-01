import * as fs from 'fs';
import * as path from 'path';

// Las respuestas del SII traen RUT, nombres y montos reales. Este repositorio
// tiene licencia y PRs, así que una fixture cruda es una filtración. El
// chequeo corre sobre todas las fixtures para que ninguna se cuele después.
const RUT_DE_PRUEBA = /^1{8}$/;

describe('fixtures anonimizadas', () => {
  const dir = __dirname;
  const fixtures = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

  it('hay fixtures que revisar', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s no contiene RUT fuera del rango de prueba', (nombre) => {
    const contenido = fs.readFileSync(path.join(dir, nombre), 'latin1');
    const ruts = [...contenido.matchAll(/\b(\d{7,8})\b\s*"?\s*;?\s*$/gm)]
      .map(m => m[1]);

    const sospechosos = ruts.filter(r => !RUT_DE_PRUEBA.test(r));
    expect(sospechosos).toEqual([]);
  });
});
