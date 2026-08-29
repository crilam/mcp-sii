import { perfil, perfilesDisponibles, PERFILES } from '../src/perfilesVerificacion';

const ORIGINAL = process.env;

beforeEach(() => { process.env = { ...ORIGINAL }; });
afterAll(() => { process.env = ORIGINAL; });

function limpiar() {
  for (const n of PERFILES) {
    delete process.env[`SII_${n.toUpperCase()}_RUT`];
    delete process.env[`SII_${n.toUpperCase()}_CLAVE`];
  }
}

describe('perfiles de verificación', () => {
  it('devuelve el RUT y la clave del perfil pedido', () => {
    limpiar();
    process.env.SII_MIPYME_RUT = '11111111-1';
    process.env.SII_MIPYME_CLAVE = 'secreta';

    expect(perfil('mipyme')).toEqual({ nombre: 'mipyme', rut: '11111111-1', clave: 'secreta' });
  });

  // Lo importante del módulo: NO sustituir una credencial por otra. Con
  // fallback, pedir el perfil de mipyme sin tenerlo cargado correría la
  // verificación contra otro contribuyente, y el verde o el rojo no diría nada
  // sobre lo que se quería probar.
  it('sin el perfil cargado falla, y no cae en otra credencial', () => {
    limpiar();
    process.env.SII_PERSONA_RUT = '22222222-2';
    process.env.SII_PERSONA_CLAVE = 'otra';
    process.env.SII_RUT = '33333333-3';
    process.env.SII_CLAVE = 'legado';

    expect(() => perfil('mipyme')).toThrow(/SII_MIPYME_RUT y SII_MIPYME_CLAVE/);
  });

  it('el mensaje dice qué es ese perfil, no sólo que falta', () => {
    limpiar();

    expect(() => perfil('mipyme')).toThrow(/Facturaci[óo]n Gratuita/);
  });

  // Un RUT vacío o con espacios es "no cargado": la plantilla del .env deja las
  // claves presentes y sin valor, así que existir no alcanza.
  it.each(['', '   '])('un RUT en blanco (%p) cuenta como faltante', (valor) => {
    limpiar();
    process.env.SII_MERCADO_RUT = valor;
    process.env.SII_MERCADO_CLAVE = 'algo';

    expect(() => perfil('mercado')).toThrow(/SII_MERCADO_RUT/);
  });

  it('falta sólo la clave: el mensaje nombra la clave y no el RUT', () => {
    limpiar();
    process.env.SII_PERSONA_RUT = '11111111-1';

    expect(() => perfil('persona')).toThrow(/SII_PERSONA_CLAVE/);
  });

  it('perfilesDisponibles informa cuáles se pueden correr', () => {
    limpiar();
    process.env.SII_PERSONA_RUT = '11111111-1';
    process.env.SII_PERSONA_CLAVE = 'a';
    process.env.SII_MERCADO_RUT = '22222222-2';
    process.env.SII_MERCADO_CLAVE = 'b';

    expect(perfilesDisponibles()).toEqual(['persona', 'mercado']);
  });

  it('sin ningún perfil cargado la lista viene vacía', () => {
    limpiar();

    expect(perfilesDisponibles()).toEqual([]);
  });
});
