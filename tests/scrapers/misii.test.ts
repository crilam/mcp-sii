import * as fs from 'fs';
import * as path from 'path';
import { extraerDatos, MisiiScraper } from '../../src/scrapers/misii';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

const HOME = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'misii-home.html'), 'utf8');

describe('extraerDatos', () => {
  // Los datos viajan embebidos en la página como `var DatosCntrNow = {...};`,
  // no llegan por AJAX: la home alcanza, y se corta el JSON balanceando llaves
  // porque adentro hay strings con puntos y comas.
  it('lee el JSON embebido y arma la ficha del contribuyente', () => {
    const d = extraerDatos(HOME);

    expect(d).toMatchObject({
      rut: '11111111-1',
      razonSocial: 'EMPRESA DE PRUEBA S.A.',
      tipoContribuyente: 'PERSONA JURIDICA COMERCIAL',
      subtipoContribuyente: 'SOCIEDADES ANONIMAS CERRADAS',
      personaEmpresa: 'EMPRESA',
      segmento: 'MEDIANA EMPRESA',
      glosaActividad: 'GLOSA DE PRUEBA',
      email: 'prueba@ejemplo.cl',
      capitalEnterado: 1000,
    });
    expect(d.nombres).toBeNull();
    // Teléfono vacío es ausencia, no cadena vacía.
    expect(d.telefonoMovil).toBeNull();
  });

  it('mapea las direcciones con comuna y región sin los espacios que trae el SII', () => {
    const d = extraerDatos(HOME);

    expect(d.direcciones).toHaveLength(1);
    expect(d.direcciones[0]).toMatchObject({
      codigo: '000000001',
      tipo: 'DOMICILIO',
      calle: 'CALLE DE PRUEBA 123',
      comuna: 'LAS CONDES',
      comunaCodigo: '15108',
      region: 'REGION METROPOLITANA',
      tipoPropiedad: 'ARRENDADO NOTARIAL',
    });
  });

  it('mapea los atributos con su vigencia', () => {
    const d = extraerDatos(HOME);

    expect(d.atributos.length).toBeGreaterThan(0);
    expect(d.atributos[0]).toEqual(expect.objectContaining({
      codigo: expect.any(String), descripcion: expect.any(String), desde: expect.any(String), hasta: null,
    }));
  });

  // Sin la marca no es la home: es el login o un rediseño. No puede leerse como
  // "contribuyente sin datos".
  it('sin el bloque DatosCntrNow falla explícito', () => {
    expect(() => extraerDatos('<html>Ingreso de RUT y clave</html>')).toThrow(/DatosCntrNow/);
  });

  it('un bloque con codigoError distinto de 0 falla con la descripción del SII', () => {
    const html = 'var DatosCntrNow = {"codigoError":0,"contribuyente":{"codigoError":5,"descripcionError":"Contribuyente no existe"}};';
    expect(() => extraerDatos(html)).toThrow(/Contribuyente no existe/);
  });

  // El primer `{` después de la marca abre el JSON, y las llaves dentro de
  // strings no cuentan: una razón social con "{" no puede romper el recorte.
  it('recorta el JSON aunque haya llaves dentro de strings', () => {
    const html = 'var DatosCntrNow = {"codigoError":0,"contribuyente":{"codigoError":0,"rut":"1","dv":"9","razonSocial":"RARA {S.A.}"},"direcciones":[],"atributos":[]}; otra = {};';
    expect(extraerDatos(html).razonSocial).toBe('RARA {S.A.}');
  });
});

describe('MisiiScraper', () => {
  it('pide la home de Mi SII guardando cookies y devuelve la ficha', async () => {
    const session = new (SessionManager as jest.MockedClass<typeof SessionManager>)({} as any, {} as any);
    const http = new (SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>)(session);
    (session.assertPuedeEntregarCookieJar as jest.Mock) = jest.fn();
    (http.get as jest.Mock).mockResolvedValue(HOME);

    const d = await new MisiiScraper(http, session).datosContribuyente();

    expect(d.rut).toBe('11111111-1');
    expect(http.get).toHaveBeenCalledWith(
      'https://misiir.sii.cl/cgi_misii/siihome.cgi', undefined, { guardarCookies: true });
  });
});
