import * as fs from 'fs';
import * as path from 'path';
import { parsearValoresMensuales, parsearTramosImpuesto } from '../../src/scrapers/indicadores';

const html = fs.readFileSync(
  path.join(__dirname, '../fixtures/indicadores-correccion.html'), 'utf8');

describe('parsearValoresMensuales — corrección monetaria', () => {
  // La tabla es triangular: un mes no tiene factor contra los meses anteriores.
  // Esos huecos van en null y NO en 0, porque un factor 0 es un factor.
  it('los huecos de la tabla triangular van en null', () => {
    expect(parsearValoresMensuales(html)).toEqual([
      { mes: 1, valores: [null, 1.1, 1.5] },
      { mes: 2, valores: [null, null, 0.4] },
      { mes: 3, valores: [null, null, null] },
    ]);
  });

  // La fixture trae una nota al pie que arranca con "Enero". Recorrer el HTML
  // entero la tomaba como la fila de enero —y se quedaba con ella, porque viene
  // ANTES que la tabla de datos—, así que enero salía con el texto de la nota
  // convertido a null en vez de sus factores.
  it('ignora una nota al pie que empieza con un nombre de mes', () => {
    const enero = parsearValoresMensuales(html).find(v => v.mes === 1)!;

    expect(enero.valores).toHaveLength(3);
    expect(enero.valores[1]).toBe(1.1);
  });

  // La fila de totales no arranca con un nombre de mes, así que se descarta sola
  // sin tener que contar filas.
  it('no toma la fila de totales como un mes', () => {
    expect(parsearValoresMensuales(html)).toHaveLength(3);
  });

  // Este test decía lo contrario —"devuelve vacío, no revienta"— y se dio vuelta
  // por un hallazgo del code review del PR #63. El vacío silencioso convive mal
  // con el bloque de acá abajo, que para los tramos exige lo opuesto: la misma
  // situación (el SII cambió su maquetado) daba error en un parser y una lista
  // vacía en el otro.
  //
  // Y la lista vacía es peor que un error, porque afirma algo: el consumidor la
  // lee como "el SII no publicó estos valores". El año que el SII realmente no
  // publica llega como 404 y sale por RecursoNoEncontrado, así que no se pierde
  // ese caso.
  it('una página sin tablas de mes es un error, no un array vacío', () => {
    expect(() => parsearValoresMensuales('<html><body>sin datos</body></html>'))
      .toThrow(/no se reconocieron/i);
  });
});

describe('parsearTramosImpuesto — fallos ruidosos', () => {
  // El hueco que quedaba: los tramos gritaban cuando reconocían las tablas pero
  // no las filas, y CALLABAN cuando no reconocían ninguna tabla — justo el
  // "vacío silencioso" que este mismo archivo arregla para diarios y mensuales.
  it('una página sin tablas de mes reconocibles es un error, no un array vacío', () => {
    const roto = '<h4>Enero 2025</h4><table><tbody>' +
      '<tr><td>MENSUAL</td><td>-.-</td><td>$ 900.000</td><td>0,04</td><td>-.-</td><td>2,2%</td></tr>' +
      '</tbody></table>';

    expect(() => parsearTramosImpuesto(roto)).toThrow(/no se reconocieron/i);
  });

  // Si el SII cambia el rótulo del período, cada tabla queda sin tramos y el
  // resultado sería un array vacío que se lee como "no publicó". Tiene que doler.
  it('tablas por mes sin ningún tramo reconocible es un error, no un array vacío', () => {
    const roto = `<h2>Enero 2025</h2><table><tbody>
      <tr><td>Mensualidad</td><td>-.-</td><td>$ 900.000</td><td>Exento</td><td>-.-</td><td>Exento</td></tr>
    </tbody></table>`;

    expect(() => parsearTramosImpuesto(roto)).toThrow(/rótulo del período/);
  });

  // Este test decía que el vacío era correcto acá, justificándolo con "un año
  // que el SII no publica". Ese caso NO llega hasta el parser: el 404 de la
  // página sale antes como `RecursoNoEncontrado`. Lo que sí llega es un
  // rediseño del portal, y ahí el vacío miente.
  it('una página sin tablas de mes también es un error', () => {
    expect(() => parsearTramosImpuesto('<html><body>nada</body></html>'))
      .toThrow(/no se reconocieron/i);
  });

  // El portal usa `<h2 class="...">` en varias páginas. Sin aceptar atributos, el
  // parser devolvía cero filas en silencio.
  it('reconoce el encabezado del mes aunque traiga atributos', () => {
    const conAtributos = `<h2 class="titulo">Marzo 2025</h2><table><tbody>
      <tr><td><strong>MENSUAL</strong></td><td>-.-</td><td>$ 900.000,00</td><td>Exento</td><td>-.-</td><td>Exento</td></tr>
    </tbody></table>`;

    expect(parsearTramosImpuesto(conAtributos)[0].mes).toBe(3);
  });

  // `rebaja` seguía el mismo criterio que `factor` y `tasaMaxima` sólo por
  // casualidad: hoy el SII escribe `-.-` ahí. Si un mes trajera `$ 0`, el tramo
  // exento saldría con rebaja 0 contra lo que promete la documentación.
  it('el tramo exento deja la rebaja en null aunque el SII escriba un cero', () => {
    const conCero = `<h2>Abril 2025</h2><table><tbody>
      <tr><td><strong>MENSUAL</strong></td><td>-.-</td><td>$ 900.000,00</td><td>Exento</td><td>$ 0</td><td>Exento</td></tr>
    </tbody></table>`;

    expect(parsearTramosImpuesto(conCero)[0].rebaja).toBeNull();
  });
});
