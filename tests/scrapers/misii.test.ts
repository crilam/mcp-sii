import * as fs from 'fs';
import * as path from 'path';
import { parsearFicha, extraerVariable, EstructuraMisiiDesconocida } from '../../src/scrapers/misii';

const html = fs.readFileSync(path.join(__dirname, '../fixtures/misii-home.html'), 'utf8');

describe('parsearFicha', () => {
  it('lee los tres bloques del payload embebido', () => {
    const ficha = parsearFicha(html);

    expect(ficha.contribuyente.razonSocial).toBe('EMPRESA DE EJEMPLO S.A.');
    expect(ficha.direcciones).toHaveLength(1);
    expect(ficha.atributos).toHaveLength(3);
    expect(ficha.actividades).toHaveLength(2);
  });

  // La regla central de este scraper. Si el SII renombra la variable, devolver
  // una ficha vacía afirmaría que el contribuyente no tiene razón social ni
  // actividades ni régimen: una afirmación falsa sobre datos del SII, hecha por
  // nosotros y sin ninguna señal.
  it('una variable ausente es error, no una ficha vacía', () => {
    const sinActeco = html.replace('DatosActeco', 'DatosOtroNombre');

    expect(() => parsearFicha(sinActeco)).toThrow(EstructuraMisiiDesconocida);
  });

  it('un payload que no es JSON válido también es error', () => {
    const roto = html.replace('"razonSocial"', '"razonSocial" :: ');

    expect(() => parsearFicha(roto)).toThrow(EstructuraMisiiDesconocida);
  });

  // Sin RUT no hay contra qué verificar identidad, y el consumidor usa ese campo
  // justamente para no escribir la ficha de otro contribuyente.
  it('un contribuyente sin RUT es error', () => {
    const sinRut = html.replace('"rut":"22222222"', '"rut":null');

    expect(() => parsearFicha(sinRut)).toThrow(/RUT/i);
  });
});

describe('extraerVariable', () => {
  // El payload tiene objetos anidados: cortar en el primer `}` daría un JSON
  // truncado, y el error de JSON.parse apuntaría a un lugar que no es el
  // problema.
  it('corta donde termina el objeto, no en la primera llave que cierra', () => {
    const crudo = extraerVariable('var X = {"a":{"b":1},"c":2}; var Y = 9;', 'X');

    expect(crudo).toBe('{"a":{"b":1},"c":2}');
  });

  it('no cuenta las llaves que están dentro de un string', () => {
    const crudo = extraerVariable('var X = {"a":"}}}","b":1};', 'X');

    expect(JSON.parse(crudo!)).toEqual({ a: '}}}', b: 1 });
  });

  it('no se confunde con una comilla escapada dentro del string', () => {
    const crudo = extraerVariable('var X = {"a":"dijo \\"}\\" y siguió","b":2};', 'X');

    expect(JSON.parse(crudo!)).toEqual({ a: 'dijo "}" y siguió', b: 2 });
  });

  it('devuelve null si la variable no está', () => {
    expect(extraerVariable('var Otra = {};', 'X')).toBeNull();
  });

  // Un nombre que es prefijo de otro no debe matchear: `DatosCntr` no es
  // `DatosCntrNow`, y devolver el payload equivocado sería un error silencioso.
  it('no matchea un nombre que es prefijo de otra variable', () => {
    expect(extraerVariable('var DatosCntrNow = {"a":1};', 'DatosCntr')).toBeNull();
  });
});
