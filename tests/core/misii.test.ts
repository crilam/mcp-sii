import * as fs from 'fs';
import * as path from 'path';
import { parsearFicha } from '../../src/scrapers/misii';
import { normalizar, regimenDe, aIso, aBooleano, PARSER_VERSION } from '../../src/core/misii';

const html = fs.readFileSync(path.join(__dirname, '../fixtures/misii-home.html'), 'utf8');
const CAPTURA = '2026-08-29T04:12:33.000Z';
const ficha = normalizar(parsearFicha(html), CAPTURA);

describe('normalización de la ficha', () => {
  it('arma el RUT con dígito verificador desde el payload, no desde el request', () => {
    expect(ficha.rut).toBe('22222222-2');
  });

  it('viaja con la procedencia: cuándo se capturó y con qué versión de parser', () => {
    expect(ficha.capturadoEn).toBe(CAPTURA);
    expect(ficha.parserVersion).toBe(PARSER_VERSION);
  });

  it('conserva el payload original bajo `crudo`', () => {
    expect(ficha.crudo.contribuyente.fechaInicioActividades).toBe('2008-05-26 00:00:00.0');
    expect(ficha.crudo.version).toBe(PARSER_VERSION);
  });

  it('normaliza las actividades, con su fecha de inicio propia', () => {
    expect(ficha.actividades[0]).toEqual({
      codigo: 522120,
      giro: 'EXPLOTACION DE ESTACIONAMIENTOS',
      categoria: 1,
      afectaIva: true,
      desde: '2015-12-16',
    });
  });

  it('convierte afectoIva "N" en false, no en null', () => {
    expect(ficha.actividades[1].afectaIva).toBe(false);
  });

  it('aplana la dirección a lo que consume una ficha de empresa', () => {
    expect(ficha.direcciones[0]).toEqual({
      tipo: 'DOMICILIO',
      calle: 'CALLE DE EJEMPLO',
      numero: '1234',
      comuna: 'LAS CONDES',
      region: 'REGION METROPOLITANA',
    });
  });

  // Los atributos son lista abierta: aparecen y desaparecen con el tiempo (hay
  // uno de postergación de IVA por la pandemia). Se entregan como bolsa, no
  // como columnas fijas — verificado con dos empresas que comparten cuatro
  // códigos y difieren en el resto.
  it('entrega los atributos como bolsa con código, glosa, vigencia y valor', () => {
    expect(ficha.atributos).toHaveLength(3);
    expect(ficha.atributos[1]).toEqual({
      codigo: 'EMTP',
      descripcion: 'EMPRESA DE MENOR TAMANO',
      desde: '2024-01-01',
      hasta: null,
      valor: 'MEDIANA',
    });
  });
});

describe('régimen tributario', () => {
  it('lo deriva del atributo cuyo código empieza con 14, con su vigencia', () => {
    expect(ficha.regimen).toEqual({
      codigo: '14D1',
      descripcion: 'REGIMEN PRO PYME GENERAL (14D)',
      desde: '2026-01-01',
      hasta: null,
    });
  });

  // No se mapea el código a un enum propio: sólo se relevó `14D1`, y se sabe
  // que existe al menos un `14D3` que nadie pudo capturar porque el portal
  // borra el régimen anterior. Inventar el resto del mapeo daría una
  // clasificación plausible y equivocada, y de ahí sale el F29.
  it('entrega el código y la glosa del SII sin traducirlos a un enum propio', () => {
    const otro = regimenDe([
      { atrCodigo: '14A', descAtrCodigo: 'REGIMEN SEMI INTEGRADO', fechaInicio: '01-01-2020', fechaTermino: null, valor: null },
    ]);

    expect(otro).toEqual({
      codigo: '14A',
      descripcion: 'REGIMEN SEMI INTEGRADO',
      desde: '2020-01-01',
      hasta: null,
    });
  });

  // Sin régimen es `null` y no un default: un default acá se propaga al F29.
  it('sin atributo de régimen devuelve null, nunca un régimen supuesto', () => {
    expect(regimenDe([
      { atrCodigo: 'NOTI', descAtrCodigo: 'NOTIFICADO POR CORREO', fechaInicio: '01-01-2020', fechaTermino: null, valor: null },
    ])).toBeNull();
  });

  // El portal sólo publica el vigente, pero si alguna vez apareciera uno
  // terminado, no puede ganar: sería el régimen de otro período.
  it('ignora un régimen con fecha de término', () => {
    expect(regimenDe([
      { atrCodigo: '14D3', descAtrCodigo: 'REGIMEN ANTERIOR', fechaInicio: '01-01-2020', fechaTermino: '31-12-2025', valor: null },
    ])).toBeNull();
  });
});

describe('normalización de fechas y booleanos', () => {
  // El SII usa los dos formatos en el MISMO payload.
  it.each([
    ['2008-05-26 00:00:00.0', '2008-05-26'],
    ['01-01-2026', '2026-01-01'],
    ['2026-01-01', '2026-01-01'],
  ])('%s se normaliza a %s', (entrada, esperado) => {
    expect(aIso(entrada)).toBe(esperado);
  });

  it('null sigue siendo null', () => {
    expect(aIso(null)).toBeNull();
  });

  // Un formato desconocido NO se convierte en null: null diría "el SII no
  // informó esta fecha", que es distinto de "la informó y no supimos leerla".
  it('un formato desconocido se devuelve tal cual, no como null', () => {
    expect(aIso('26 de mayo de 2008')).toBe('26 de mayo de 2008');
  });

  it.each([
    ['S', true], ['SI', true], ['N', false], ['No', false],
  ])('el booleano %s del SII es %s', (entrada, esperado) => {
    expect(aBooleano(entrada as string)).toBe(esperado);
  });

  // Un valor que no se reconoce no es `false`: un false inventado afirma que el
  // SII dijo que no.
  it('un valor no reconocido es null, no false', () => {
    expect(aBooleano('QUIZAS')).toBeNull();
  });
});
