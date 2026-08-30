import * as fs from 'fs';
import * as path from 'path';
import { extraerDatos, extraerFicha, PARSER_VERSION } from '../../src/scrapers/misii';

// Lo que se portó desde la rama paralela (PR #67, cerrado a favor de esta
// implementación, que ya estaba en main): lo que el consumidor contable
// necesita y la ficha todavía no traía.
const HOME = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'misii-home.html'), 'utf8');

describe('actividades económicas del contribuyente', () => {
  // Salen de `DatosActeco`, un segundo bloque embebido en la misma página. No
  // son el catálogo público de códigos que expone /v1/contribuyentes: son las
  // actividades de ESTE contribuyente, con la fecha desde la que las tiene.
  it('lee las actividades del segundo bloque embebido', () => {
    const datos = extraerFicha(HOME);

    expect(datos.actividades).toHaveLength(2);
    expect(datos.actividades[1]).toEqual({
      codigo: '749900',
      giro: 'OTRAS ACTIVIDADES PROFESIONALES N.C.P.',
      categoria: '1',
      afectaIva: false,
      desde: '2019-03-01',
    });
  });

  // El código ACTECO se conserva como STRING: varios empiezan con cero (011101
  // es cultivo de trigo) y pasarlos a número se lo come, dejando un código que
  // no cruza contra la tabla de actividades del SII.
  it('conserva el cero a la izquierda del código', () => {
    expect(extraerFicha(HOME).actividades[0].codigo).toBe('011101');
  });

  // El `afectoIva` del SII es "S"/"N". Un valor que no se reconoce va en null y
  // NO en false: un false inventado afirma que el SII dijo que no.
  it('convierte afectoIva a booleano de verdad', () => {
    const acts = extraerFicha(HOME).actividades;

    expect(acts[0].afectaIva).toBe(true);
    expect(acts[1].afectaIva).toBe(false);
  });

  // Una página sin el bloque no es un contribuyente sin actividades: es un
  // cambio del portal, y devolver [] lo afirmaría al revés — el mismo criterio
  // que ya aplica `DatosCntrNow`.
  it('sin el bloque DatosActeco falla, no devuelve lista vacía', () => {
    const sinActeco = HOME.replace('DatosActeco', 'DatosOtroNombre');

    expect(() => extraerFicha(sinActeco)).toThrow(/DatosActeco/);
  });

  // Cada elemento trae su propio `codigoError`: un contribuyente sin
  // actividades devuelve un elemento de error con todo en null, que sin filtrar
  // pasaría como una actividad real con código y giro vacíos.
  it('descarta el elemento de error sin código', () => {
    const conFantasma = HOME.replace(
      'var DatosActeco = [{',
      'var DatosActeco = [{"codigoError": 2, "descripcion": null, "codigo": null}, {');

    expect(extraerFicha(conFantasma).actividades).toHaveLength(2);
  });
});

describe('régimen tributario derivado', () => {
  // El consumidor contable necesita el régimen, no la bolsa de atributos: si lo
  // deriva cada cliente, cada uno repite la misma regla y el mismo error. De
  // este dato sale el F29.
  it('deriva el régimen del atributo 14* vigente, con su vigencia', () => {
    expect(extraerDatos(HOME).regimen).toEqual({
      codigo: '14D1',
      descripcion: 'REGIMEN PRO PYME GENERAL (14D)',
      desde: '2026-01-01',
      hasta: null,
    });
  });

  // Sin atributo de régimen va null —"no se pudo determinar"—, nunca un
  // supuesto: un default acá se propaga al F29 del consumidor.
  it('sin atributo de régimen devuelve null, no un régimen supuesto', () => {
    const sinRegimen = HOME.replace(/"atrCodigo": "14D1"/, '"atrCodigo": "ZZZZ"');

    expect(extraerDatos(sinRegimen).regimen).toBeNull();
  });

  // Dos vigentes a la vez no se resuelve tomando el primero: el orden del array
  // no es un criterio.
  it('con dos regímenes vigentes falla en vez de elegir uno', () => {
    const dos = HOME.replace(/"atrCodigo": "BOLE"/, '"atrCodigo": "14A"');

    expect(() => extraerDatos(dos)).toThrow(/14D1, 14A/);
  });

  // Un término FUTURO sigue vigente hoy: descartarlo devolvería null para un
  // régimen que el SII informa.
  it('un régimen con término futuro sigue vigente', () => {
    const futuro = HOME.replace(
      /"atrCodigo": "14D1", "descAtrCodigo": "REGIMEN PRO PYME GENERAL \(14D\)", "fechaInicio": "01-01-2026", "valor": "Inscripción Internet", "fechaTermino": null/,
      '"atrCodigo": "14D1", "descAtrCodigo": "REGIMEN PRO PYME GENERAL (14D)", "fechaInicio": "01-01-2026", "valor": "Inscripción Internet", "fechaTermino": "31-12-2099"');

    expect(extraerDatos(futuro).regimen).toMatchObject({ codigo: '14D1', hasta: '2099-12-31' });
  });
});

describe('procedencia de la captura', () => {
  // El consumidor guarda la versión con cada captura para poder auditar hacia
  // atrás un dato que después resultó estar mal.
  it('trae la versión del parser', () => {
    expect(extraerDatos(HOME).parserVersion).toBe(PARSER_VERSION);
  });
});
