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

  // El código ACTECO va como STRING y no como número: varios empiezan con cero
  // (011101 es agricultura) y convertirlos a número se lo come, dejando un
  // código que no existe y que no cruza contra la tabla de actividades del SII.
  it('conserva el código de actividad como string, con su cero a la izquierda', () => {
    const conCero = normalizar({
      contribuyente: { rut: '22222222', dv: '2' } as never,
      direcciones: [], atributos: [], alertas: [],
      actividades: [{
        codigo: '011101', descripcion: 'CULTIVO DE TRIGO', categoriaTributaria: '1',
        afectoIva: 'S', fechaInicio: '01-01-2020',
      }],
    }, CAPTURA);

    expect(conCero.actividades[0].codigo).toBe('011101');
  });

  it('normaliza las actividades, con su fecha de inicio propia', () => {
    expect(ficha.actividades[0]).toEqual({
      codigo: '522120',
      giro: 'EXPLOTACION DE ESTACIONAMIENTOS',
      categoria: 1,
      afectaIva: true,
      desde: '2015-12-16',
    });
  });

  it('convierte afectoIva "N" en false, no en null', () => {
    expect(ficha.actividades[1].afectaIva).toBe(false);
  });

  // Con el código de la dirección y los de comuna y región: el primero es lo
  // único que distingue una sucursal de otra, y las descripciones no cruzan
  // contra las tablas oficiales.
  it('aplana la dirección conservando los códigos, no sólo las descripciones', () => {
    expect(ficha.direcciones[0]).toEqual({
      codigo: '90000001',
      tipo: 'DOMICILIO',
      calle: 'CALLE DE EJEMPLO',
      numero: '1234',
      comuna: { codigo: '13114', descripcion: 'LAS CONDES' },
      region: { codigo: '13', descripcion: 'REGION METROPOLITANA' },
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

  // Dos vigentes a la vez no debería pasar, y por eso mismo no se resuelve
  // eligiendo el primero: el orden del array no es un criterio, y de este campo
  // sale el F29. Falla mostrando los dos códigos.
  it('con dos regímenes vigentes falla en vez de elegir uno', () => {
    expect(() => regimenDe([
      { atrCodigo: '14D1', descAtrCodigo: 'PRO PYME GENERAL', fechaInicio: '01-01-2026', fechaTermino: null, valor: null },
      { atrCodigo: '14A', descAtrCodigo: 'SEMI INTEGRADO', fechaInicio: '01-01-2020', fechaTermino: null, valor: null },
    ])).toThrow(/14D1, 14A/);
  });
});

describe('atributos incompletos', () => {
  // Un atributo sin código saldría como la cadena "undefined", que el consumidor
  // trataría como un código real del SII. Un atributo de menos es preferible a
  // uno inventado.
  it('descarta el atributo sin código en vez de emitir "undefined"', () => {
    const ficha2 = normalizar({
      contribuyente: { rut: '22222222', dv: '2' } as never,
      direcciones: [],
      actividades: [],
      alertas: [],
      atributos: [
        { atrCodigo: undefined as never, descAtrCodigo: 'SIN CODIGO', fechaInicio: null, fechaTermino: null, valor: null },
        { atrCodigo: 'NOTI', descAtrCodigo: 'NOTIFICADO', fechaInicio: '01-01-2020', fechaTermino: null, valor: null },
      ],
    }, CAPTURA);

    expect(ficha2.atributos.map(a => a.codigo)).toEqual(['NOTI']);
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
    ['S', true], ['SI', true], ['Sí', true], ['N', false], ['No', false], [' s ', true],
  ])('el booleano %s del SII es %s', (entrada, esperado) => {
    expect(aBooleano(entrada as string)).toBe(esperado);
  });

  // Un valor que no se reconoce no es `false`: un false inventado afirma que el
  // SII dijo que no.
  it('un valor no reconocido es null, no false', () => {
    expect(aBooleano('QUIZAS')).toBeNull();
  });
});
