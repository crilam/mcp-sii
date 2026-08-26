import * as fs from 'fs';
import * as path from 'path';
import {
  parsearValoresDiarios,
  parsearValoresMensuales,
  numeroChileno,
} from '../../src/scrapers/indicadores';

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '../fixtures', nombre), 'latin1');
}

// Cada test de acá corresponde a una trampa que se encontró contra la página
// real. Todas comparten la misma forma de fallar: devolver un número plausible y
// equivocado, que nadie revisa.
describe('numeroChileno', () => {
  // La UF: punto de miles, coma decimal.
  it('lee el formato de la UF', () => {
    expect(numeroChileno('40.875,09')).toBe(40875.09);
    expect(numeroChileno('1.234.567,89')).toBe(1234567.89);
  });

  // El dólar: punto DECIMAL, sin miles. Tratarlo como la UF daba 92816 en vez de
  // 928.16 — mil veces más y creíble a simple vista.
  it('lee el formato del dólar, que usa punto decimal', () => {
    expect(numeroChileno('928.16')).toBe(928.16);
    expect(numeroChileno('950.5')).toBe(950.5);
    expect(numeroChileno('1000.75')).toBe(1000.75);
  });

  // Un punto con TRES cifras detrás es separador de miles, no decimal.
  it('trata el punto con tres cifras como separador de miles', () => {
    expect(numeroChileno('69.542')).toBe(69542);
    expect(numeroChileno('834.504')).toBe(834504);
  });

  // Lo que NO es un cero. Publicar 0 acá sería inventar un valor: en un tipo de
  // cambio o una UF, un cero es un dato absurdo que igual se propaga.
  it('devuelve null para lo que el SII no informa', () => {
    expect(numeroChileno('')).toBeNull();
    expect(numeroChileno('   ')).toBeNull();
    expect(numeroChileno('&nbsp;')).toBeNull();
    // "-.-" es como el SII escribe "no corresponde" en las tablas de impuesto.
    expect(numeroChileno('-.-')).toBeNull();
    expect(numeroChileno(undefined)).toBeNull();
  });

  it('conserva el signo negativo', () => {
    expect(numeroChileno('-0,2')).toBe(-0.2);
  });
});

describe('parsearValoresDiarios', () => {
  // LA trampa principal: las tablas vienen en orden inverso (marzo, febrero,
  // enero). Indexar por posición mapearía marzo como enero — todos los valores
  // en el mes equivocado, y ninguno absurdo.
  it('usa el nombre del mes y no su posición en la página', () => {
    const filas = parsearValoresDiarios(fixture('indicadores-uf.html'));

    const enero = filas.filter(f => f.mes === 1);
    const marzo = filas.filter(f => f.mes === 3);
    // El primer bloque de la página es MARZO, y sus valores tienen que quedar en
    // el mes 3.
    expect(marzo.find(f => f.dia === 1)?.valor).toBe(39100.10);
    // Enero es el ÚLTIMO bloque y va al mes 1.
    expect(enero.find(f => f.dia === 1)?.valor).toBe(38384.41);
  });

  // Cada fila trae TRES pares día/valor, no un día por fila.
  it('lee los tres pares día/valor de cada fila', () => {
    const filas = parsearValoresDiarios(fixture('indicadores-uf.html'));
    const febrero = filas.filter(f => f.mes === 2);

    expect(febrero.map(f => f.dia).sort((a, b) => a - b)).toEqual([1, 11, 21]);
    expect(febrero.find(f => f.dia === 21)?.valor).toBe(38920.75);
  });

  // Un día sin valor NO aparece con 0: no aparece. Así el consumidor distingue
  // "el SII no publicó ese día" de "el valor es cero".
  it('omite los días que el SII no publicó, en vez de ponerlos en cero', () => {
    const filas = parsearValoresDiarios(fixture('indicadores-uf.html'));
    const marzo = filas.filter(f => f.mes === 3);

    expect(marzo.some(f => f.dia === 21)).toBe(false);
    expect(marzo.some(f => f.dia === 12)).toBe(false);
    expect(filas.some(f => f.valor === 0)).toBe(false);
  });

  // El bug que costó 31 días fantasma: el bloque del ÚLTIMO mes tomaba hasta el
  // final del documento, arrastrando el pie de página —que trae otra tabla— y
  // duplicando enero. El total daba 396 en un año de 365, con cada día repetido
  // con el mismo valor: invisible salvo contando.
  it('no arrastra las tablas que vienen después del último mes', () => {
    const filas = parsearValoresDiarios(fixture('indicadores-uf.html'));
    const enero = filas.filter(f => f.mes === 1);

    expect(enero).toHaveLength(3);
    // El valor del pie (99.999,99) no puede aparecer en ningún mes.
    expect(filas.some(f => f.valor === 99999.99)).toBe(false);
    // Y ningún día repetido en ningún mes.
    for (const mes of new Set(filas.map(f => f.mes))) {
      const dias = filas.filter(f => f.mes === mes).map(f => f.dia);
      expect(new Set(dias).size).toBe(dias.length);
    }
  });

  // El dólar titula con h3 y no con h2. Buscar sólo uno devolvía CERO filas, y
  // en silencio: una lista vacía se lee como "el SII no publicó nada".
  it('reconoce los meses titulados con h3, como el dólar', () => {
    const filas = parsearValoresDiarios(fixture('indicadores-dolar.html'));

    expect(filas.length).toBeGreaterThan(0);
    expect(new Set(filas.map(f => f.mes))).toEqual(new Set([1, 2]));
    // Y con el formato de punto decimal bien leído.
    expect(filas.find(f => f.mes === 1 && f.dia === 21)?.valor).toBe(1000.75);
    expect(filas.find(f => f.mes === 2 && f.dia === 11)?.valor).toBe(950.5);
  });
});

describe('parsearValoresMensuales', () => {
  it('indexa por el nombre del mes de la primera celda', () => {
    const filas = parsearValoresMensuales(fixture('indicadores-utm.html'));

    expect(filas.map(f => f.mes)).toEqual([1, 2, 12]);
    // UTM, UTA, IPC y variación de enero, en el orden en que los publica el SII.
    expect(filas[0].valores).toEqual([67429, 809148, 106.74, 1.1]);
  });

  // La fila de cabecera y la de totales no son meses: se descartan solas por no
  // empezar con un nombre de mes, sin tener que contar filas.
  it('descarta la cabecera y la fila de totales', () => {
    const filas = parsearValoresMensuales(fixture('indicadores-utm.html'));

    expect(filas).toHaveLength(3);
    expect(filas.some(f => f.valores.every(v => v === null))).toBe(false);
  });

  it('devuelve los meses ordenados aunque la página no lo esté', () => {
    const filas = parsearValoresMensuales(fixture('indicadores-utm.html'));
    expect(filas.map(f => f.mes)).toEqual([...filas.map(f => f.mes)].sort((a, b) => a - b));
  });

  it('conserva el negativo de una variación', () => {
    const filas = parsearValoresMensuales(fixture('indicadores-utm.html'));
    expect(filas.find(f => f.mes === 12)?.valores[3]).toBe(-0.2);
  });
});
