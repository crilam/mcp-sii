import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  perfil, perfilesDisponibles, credencialParaBody, PERFILES,
} from '../src/perfilesVerificacion';

const ORIGINAL = process.env;
let dir: string;
let pfx: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfiles-'));
  pfx = path.join(dir, 'cert.pfx');
  fs.writeFileSync(pfx, Buffer.from([0x30, 0x82, 0x01, 0x02]));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = ORIGINAL;
});
beforeEach(() => { process.env = { ...ORIGINAL }; limpiar(); });

function limpiar() {
  for (const n of PERFILES) {
    delete process.env[`SII_${n.toUpperCase()}_RUT`];
    delete process.env[`SII_${n.toUpperCase()}_CLAVE`];
  }
  delete process.env.SII_CERT_PATH;
  delete process.env.SII_CERT_PASSWORD;
  delete process.env.SII_CERT_RUT;
}

describe('perfiles con clave', () => {
  it('devuelve el RUT y la clave del perfil pedido', () => {
    process.env.SII_MIPYME_RUT = '11111111-1';
    process.env.SII_MIPYME_CLAVE = 'secreta';

    expect(perfil('mipyme')).toEqual({
      nombre: 'mipyme', rut: '11111111-1',
      credencial: { tipo: 'clave', clave: 'secreta' },
    });
  });

  // Lo importante del módulo: NO sustituir una credencial por otra. Con
  // fallback, pedir el perfil de mipyme sin tenerlo cargado correría la
  // verificación contra otro contribuyente, y el verde o el rojo no diría nada
  // sobre lo que se quería probar.
  it('sin el perfil cargado falla, y no cae en otra credencial', () => {
    process.env.SII_PERSONA_RUT = '22222222-2';
    process.env.SII_PERSONA_CLAVE = 'otra';
    process.env.SII_RUT = '33333333-3';
    process.env.SII_CLAVE = 'legado';

    expect(() => perfil('mipyme')).toThrow(/SII_MIPYME_RUT y SII_MIPYME_CLAVE/);
  });

  it('el mensaje dice qué es ese perfil, no sólo que falta', () => {
    expect(() => perfil('mipyme')).toThrow(/Facturaci[óo]n Gratuita/);
  });

  it.each(['', '   '])('un RUT en blanco (%p) cuenta como faltante', (valor) => {
    process.env.SII_MERCADO_RUT = valor;
    process.env.SII_MERCADO_CLAVE = 'algo';

    expect(() => perfil('mercado')).toThrow(/SII_MERCADO_RUT/);
  });

  it('falta sólo la clave: el mensaje nombra la clave y no el RUT', () => {
    process.env.SII_PERSONA_RUT = '11111111-1';

    expect(() => perfil('persona')).toThrow(/SII_PERSONA_CLAVE/);
  });
});

describe('perfil con certificado', () => {
  function cargar() {
    process.env.SII_CERT_RUT = '11111111-1';
    process.env.SII_CERT_PATH = pfx;
    process.env.SII_CERT_PASSWORD = 'clave-del-pfx';
  }

  // El .env guarda la RUTA del .pfx —es un binario de varios KB— y las rutas
  // REST reciben base64. La conversión vive en el módulo para que no la repita
  // cada script.
  it('lee el archivo del disco y lo entrega en base64', () => {
    cargar();

    const p = perfil('certificado');

    expect(p.credencial).toEqual({
      tipo: 'certificado',
      certificadoBase64: fs.readFileSync(pfx).toString('base64'),
      certificadoPassword: 'clave-del-pfx',
    });
  });

  // `~` no lo expande nadie cuando el valor sale de un .env: sin esto una ruta
  // bien escrita falla con un ENOENT que manda a buscar el archivo donde no está.
  it('expande ~ al home', () => {
    const enHome = path.join(os.homedir(), `.perfiles-test-${process.pid}.pfx`);
    fs.writeFileSync(enHome, Buffer.from([1, 2, 3]));
    try {
      cargar();
      process.env.SII_CERT_PATH = `~/${path.basename(enHome)}`;

      expect(perfil('certificado').credencial).toMatchObject({
        certificadoBase64: Buffer.from([1, 2, 3]).toString('base64'),
      });
    } finally {
      fs.rmSync(enHome, { force: true });
    }
  });

  // Un certificado que no está en disco tiene que decir DÓNDE se buscó: el
  // error de fs a secas manda a revisar permisos cuando el problema es la ruta.
  it('si el archivo no existe, el error dice la ruta y qué se esperaba', () => {
    cargar();
    process.env.SII_CERT_PATH = path.join(dir, 'no-esta.pfx');

    expect(() => perfil('certificado')).toThrow(/no-esta\.pfx, que no existe/);
  });

  // El titular NO se deduce de SII_RUT: el legado usa esa variable para otra
  // cosa, y adivinarlo haría firmar como un contribuyente que nadie eligió.
  it('sin SII_CERT_RUT falla, aunque SII_RUT esté cargada', () => {
    cargar();
    delete process.env.SII_CERT_RUT;
    process.env.SII_RUT = '99999999-9';

    expect(() => perfil('certificado')).toThrow(/SII_CERT_RUT/);
  });

  it('sin la password del certificado falla nombrándola', () => {
    cargar();
    delete process.env.SII_CERT_PASSWORD;

    expect(() => perfil('certificado')).toThrow(/SII_CERT_PASSWORD/);
  });
});

describe('credencialParaBody', () => {
  it('la clave va como `clave`', () => {
    process.env.SII_PERSONA_RUT = '11111111-1';
    process.env.SII_PERSONA_CLAVE = 'secreta';

    expect(credencialParaBody(perfil('persona')))
      .toEqual({ rut: '11111111-1', clave: 'secreta' });
  });

  // Los nombres de los campos son los del contrato REST, no los del módulo: si
  // se escribieran distinto, la ruta respondería 400 y parecería un problema de
  // la credencial y no del nombre del campo.
  it('el certificado va con los nombres del contrato REST', () => {
    process.env.SII_CERT_RUT = '11111111-1';
    process.env.SII_CERT_PATH = pfx;
    process.env.SII_CERT_PASSWORD = 'clave-del-pfx';

    const body = credencialParaBody(perfil('certificado'));

    expect(Object.keys(body).sort())
      .toEqual(['certificado_base64', 'certificado_password', 'rut']);
    // Nunca las dos formas juntas: `conCredencial` rechaza la mezcla.
    expect(body.clave).toBeUndefined();
  });
});

describe('perfilesDisponibles', () => {
  it('informa cuáles se pueden correr', () => {
    process.env.SII_PERSONA_RUT = '11111111-1';
    process.env.SII_PERSONA_CLAVE = 'a';
    process.env.SII_MERCADO_RUT = '22222222-2';
    process.env.SII_MERCADO_CLAVE = 'b';

    expect(perfilesDisponibles()).toEqual(['persona', 'mercado']);
  });

  it('cuenta el de certificado cuando está completo', () => {
    process.env.SII_CERT_RUT = '11111111-1';
    process.env.SII_CERT_PATH = pfx;
    process.env.SII_CERT_PASSWORD = 'x';

    expect(perfilesDisponibles()).toEqual(['certificado']);
  });

  // Un certificado configurado pero ausente del disco NO está disponible: si
  // contara, el script lo intentaría y fallaría a mitad de la verificación.
  it('no cuenta el certificado si el archivo no está en disco', () => {
    process.env.SII_CERT_RUT = '11111111-1';
    process.env.SII_CERT_PATH = path.join(dir, 'fantasma.pfx');
    process.env.SII_CERT_PASSWORD = 'x';

    expect(perfilesDisponibles()).toEqual([]);
  });

  it('sin ningún perfil cargado la lista viene vacía', () => {
    expect(perfilesDisponibles()).toEqual([]);
  });
});
