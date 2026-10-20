import { readFileSync } from 'fs';
import { join } from 'path';

// La verificación es de SÓLO LECTURA. El recolector es la única parte que
// habla con el SII, así que se fija la lista de lo que importa: agregar una
// escritura (emitir, acusar, borradores) obliga a tocar este test a mano.
const PERMITIDOS = [
  '../core/f29', '../core/rcv', '../core/misii', '../erroresConsulta', '../registroSesiones',
  '../session', '../scrapers/rcv', './pdfCompacto', './reglas', './plazos',
];

describe('f29Verificacion es de sólo lectura', () => {
  it('el recolector sólo importa consultas', () => {
    const fuente = readFileSync(join(__dirname, '../../src/f29Verificacion/recolector.ts'), 'utf8');
    const imports = [...fuente.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports.filter(i => !PERMITIDOS.includes(i))).toEqual([]);
  });

  it('el resto del módulo no habla con el SII', () => {
    for (const archivo of ['reglas.ts', 'condicionIva.ts', 'plazos.ts', 'pdfCompacto.ts', 'reporte.ts']) {
      const fuente = readFileSync(join(__dirname, '../../src/f29Verificacion', archivo), 'utf8');
      expect([archivo, /from '\.\.\/(core|http|session|scrapers\/(?!rcv'|misii'))/.test(fuente)]).toEqual([archivo, false]);
    }
  });
});
