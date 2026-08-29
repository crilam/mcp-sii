import * as fs from 'fs';
import * as path from 'path';
import { parsearActividades } from '../../src/scrapers/actividadesEconomicas';

// Recorte REAL de la página pública del SII: dos rubros, un subrubro y sus
// códigos, más una fila con categoría "G".
const html = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'actividades-economicas.html'), 'latin1');

describe('parsearActividades', () => {
  // Las tres clases de fila (rubro, cabecera de subrubro, código) se distinguen
  // por FORMA, no por posición: contar filas se rompería con el primer rubro que
  // tenga otro largo.
  it('reconoce rubro, subrubro y códigos por la forma de la fila', () => {
    const a = parsearActividades(html);

    expect(a).toHaveLength(8);
    expect(a[0]).toEqual({
      codigo: '011101',
      descripcion: 'CULTIVO DE TRIGO',
      rubro: 'AGRICULTURA, GANADERÍA, SILVICULTURA Y PESCA',
      subrubro: 'CULTIVO DE PLANTAS NO PERENNES',
      afectaIva: true,
      categoriaTributaria: '1',
      disponibleInternet: true,
    });
  });

  it('decodifica las entidades HTML de los nombres', () => {
    const a = parsearActividades(html);

    expect(a[1].descripcion).toBe('CULTIVO DE MAÍZ');
  });

  // El SII publica "G" como categoría en algunos códigos y no explica qué es.
  // Convertirla a 1 o 2 sería inventar: se conserva tal cual, como texto.
  it('conserva la categoría tributaria tal como la publica el SII, aunque sea una letra', () => {
    const g = parsearActividades(html).find(x => x.codigo === '091002')!;

    expect(g.categoriaTributaria).toBe('G');
    // "G" en la columna de IVA tampoco es "SI": no afecta.
    expect(g.afectaIva).toBe(false);
  });

  // Una página sin la tabla, o una tabla que ya no trae códigos, es un cambio de
  // formato: no puede volverse "cero actividades", que se lee como dato.
  it('sin tabla falla explícito', () => {
    expect(() => parsearActividades('<html><body>nada</body></html>')).toThrow(/no trae la tabla/);
  });

  it('una tabla sin códigos reconocibles falla explícito', () => {
    expect(() => parsearActividades('<table><tr><td>Rubro</td></tr><tr><td>x</td><td>y</td></tr></table>'))
      .toThrow(/ningún código reconocible/);
  });
});
