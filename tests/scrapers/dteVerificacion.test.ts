import * as fs from 'fs';
import * as path from 'path';
import { parsearValidez, parsearContenido, DteVerificacionScraper } from '../../src/scrapers/dteVerificacion';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

// Respuestas REALES de los CGI (anonimizadas), incluidos los dos casos
// negativos: el mismo documento con el monto cambiado en un peso, y un folio
// inexistente.
const fixture = (n: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n), 'latin1');

describe('parsearValidez', () => {
  it('lee el veredicto, el emisor y el envío de un documento recibido', () => {
    const r = parsearValidez(fixture('dte-validez.html'));

    expect(r).toMatchObject({
      recibidoPorElSii: true,
      resultado: 'Documento recibido por el SII',
      emisorNombre: 'EMISOR DE PRUEBA LTDA',
      identificadorEnvio: '10000000001',
      rutEmisor: '33333333-3',
      tipoDteNombre: 'Factura Electronica',
      folio: 124,
    });
    expect(r.comprobante).toMatch(/\d+ - \d{4}\/\d{2}\/\d{2}/);
  });

  // Un folio inexistente no es un error del scraper: es un veredicto del SII.
  it('un folio inexistente es "Documento no autorizado" con envío en asteriscos', () => {
    const r = parsearValidez(fixture('dte-validez-no-autorizado.html'));

    expect(r.recibidoPorElSii).toBe(false);
    expect(r.resultado).toBe('Documento no autorizado');
    expect(r.identificadorEnvio).toBe('**********');
    expect(r.folio).toBe(99999999);
  });

  // Sin resultado no hay veredicto: puede ser el login o un rediseño, y no
  // puede leerse como "documento inválido".
  it('una página sin resultado falla explícito', () => {
    expect(() => parsearValidez('<html>Ingreso de RUT y clave</html>')).toThrow(/no devolvió un resultado/);
  });
});

describe('parsearContenido', () => {
  it('lee fecha, receptor y monto cuando los datos coinciden', () => {
    const r = parsearContenido(fixture('dte-contenido.html'));

    expect(r).toMatchObject({
      recibidoPorElSii: true,
      datosCoinciden: true,
      resultado: 'Documento recibido por el SII. Datos coinciden con los registrados',
      emisorNombre: 'EMISOR DE PRUEBA LTDA',
      rutEmisor: '33333333-3',
      folio: 124,
      fechaEmision: '2025-07-31',
      rutReceptor: '11111111-1',
      montoTotal: 68366,
    });
  });

  // "Datos coinciden" y "datos NO coinciden" comparten casi todas las palabras:
  // un `includes('coinciden')` daría verdadero en los dos. Medido con el mismo
  // documento y el monto cambiado en un peso.
  it('el monto equivocado es "NO coinciden" y datosCoinciden false', () => {
    const r = parsearContenido(fixture('dte-contenido-no-coincide.html'));

    expect(r.recibidoPorElSii).toBe(true);
    expect(r.datosCoinciden).toBe(false);
    expect(r.resultado).toMatch(/NO coinciden/);
    // En el caso negativo el SII omite el nombre del emisor.
    expect(r.emisorNombre).toBe('');
    expect(r.montoTotal).toBe(68367);
  });
});

describe('DteVerificacionScraper', () => {
  function armar(html: string) {
    const session = new (SessionManager as jest.MockedClass<typeof SessionManager>)({} as any, {} as any);
    const http = new (SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>)(session);
    (session.assertPuedeEntregarCookieJar as jest.Mock) = jest.fn();
    (session.identidad as jest.Mock) = jest.fn(() => ({ rut: '11111111', dv: '1' }));
    (http.get as jest.Mock).mockResolvedValue('<html>form</html>');
    (http.postForm as jest.Mock).mockResolvedValue(html);
    return { scraper: new DteVerificacionScraper(http, session), http };
  }

  // El GET del formulario no es decorativo: deja la sesión del CGI armada.
  it('validez abre el formulario y manda los campos con los nombres del CGI', async () => {
    const { scraper, http } = armar(fixture('dte-validez.html'));

    await scraper.validez({ rutEmisor: '33.333.333-3', tipoDte: 33, folio: 124 });

    expect(http.get).toHaveBeenCalledWith(
      'https://palena.sii.cl/cgi_dte/UPL/DTEauth?2', undefined, { guardarCookies: true });
    expect(http.postForm).toHaveBeenCalledWith('https://palena.sii.cl/cgi_dte/UPL/QValidaDTE', {
      rutConsulta: '11111111', dvConsulta: '1', rutQuery: '33333333', dvQuery: '3', tipoDTE: '33', folioDTE: '124',
    }, { charset: 'latin1' });
  });

  it('contenido manda la fecha como ddmmaaaa y el monto sin decimales', async () => {
    const { scraper, http } = armar(fixture('dte-contenido.html'));

    await scraper.contenido({
      rutEmisor: '33333333-3', tipoDte: 33, folio: 124, rutReceptor: '11111111-1',
      fechaEmision: '2025-07-31', montoTotal: 68366,
    });

    expect(http.postForm).toHaveBeenCalledWith('https://palena.sii.cl/cgi_dte/UPL/QEstadoDTE',
      expect.objectContaining({ fechaDTE: '31072025', montoDTE: '68366', rutCompany: '33333333', dvCompany: '3', rutReceiver: '11111111', dvReceiver: '1' }),
      { charset: 'latin1' });
  });

  it('rechaza una fecha que no sea YYYY-MM-DD antes de tocar la red', async () => {
    const { scraper, http } = armar('');

    await expect(scraper.contenido({
      rutEmisor: '33333333-3', tipoDte: 33, folio: 1, rutReceptor: '11111111-1', fechaEmision: '31/07/2025', montoTotal: 1,
    })).rejects.toThrow(/YYYY-MM-DD/);
    expect(http.postForm).not.toHaveBeenCalled();
  });
});
