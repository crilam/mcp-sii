import * as fs from 'fs';
import * as path from 'path';
import { parsearFicha, extraerVariable, EstructuraMisiiDesconocida } from '../../src/scrapers/misii';
import { LimitacionConocida } from '../../src/erroresConsulta';
import { SesionExpirada } from '../../src/erroresSesion';

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

  // Un cambio de estructura del portal es PERMANENTE: reintentarlo no lo
  // arregla y sólo gasta sesiones del SII. Si el error no es una
  // `LimitacionConocida`, el adaptador REST lo colapsa a `ERROR`, que en el
  // contrato significa "reintentá" — y el tenant reintenta en loop algo que no
  // va a funcionar hasta que alguien arregle el parser.
  it('el cambio de estructura es una limitación conocida, no un error reintentable', () => {
    const sinActeco = html.replace('DatosActeco', 'DatosOtroNombre');

    expect(() => parsearFicha(sinActeco)).toThrow(LimitacionConocida);
  });

  // Si la sesión no llegó a `misiir.sii.cl`, el portal devuelve el HTML del
  // login. Ahí tampoco está `DatosCntrNow`, así que sin distinguirlo el
  // diagnóstico dice "cambió la estructura de la página" —falso— y encima, al
  // ser limitación conocida, lo marca como permanente: una sesión vencida se
  // reintenta y punto.
  // Regresión encontrada EN VIVO, no en el fixture: la ficha legítima habla de
  // la clave tributaria en su propio menú ("Historial de Cambios de Clave
  // Tributaria"), así que una detección por menciones de texto declaraba
  // expirada una sesión perfectamente válida. Sólo el formulario distingue.
  it('una ficha válida que menciona la clave tributaria NO es login', () => {
    const conMenu = html.replace('<div id="datosContribuyente">',
      '<a href="#">Historial de Cambios de Clave Tributaria</a><div id="datosContribuyente">');

    expect(parsearFicha(conMenu).contribuyente.razonSocial).toBe('EMPRESA DE EJEMPLO S.A.');
  });

  it('la página de login es sesión expirada, no un cambio de estructura', () => {
    const login = `<html><head><title>Servicio de Impuestos Internos</title></head><body>
      <form action="https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi">
      <input name="rutcntr"><input type="password" name="clave">
      <p>Ingrese su RUT y Clave Tributaria para autenticarse</p></form></body></html>`;

    expect(() => parsearFicha(login)).toThrow(SesionExpirada);
  });

  // El propio payload informa errores del SII. Sin mirarlo, un `codigoError`
  // distinto de cero se reportaba como cambio de estructura, que apunta al
  // lugar equivocado a quien tiene que diagnosticar.
  it('un codigoError del SII se propaga con su descripción, no como cambio de estructura', () => {
    const conError = html.replace(
      '{"codigoError":0,"descripcionError":"OK"',
      '{"codigoError":9,"descripcionError":"Contribuyente no existe"');

    expect(() => parsearFicha(conError)).toThrow(/Contribuyente no existe/);
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
