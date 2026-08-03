import * as fs from 'fs';
import * as path from 'path';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', nombre), 'utf-8');
}

const SEL_EMPRESA = fixture('mipyme-sel-empresa.html');
const HISTORIAL = fixture('mipyme-historial-emitidos.html');
const SIN_EMPRESA = fixture('mipyme-sin-empresa.html');

function armar() {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (MockSession.prototype.conEmpresaExclusiva as jest.Mock) = jest.fn(
    (fn: () => Promise<unknown>) => fn()
  );
  (session.conEmpresaExclusiva as jest.Mock) = jest.fn((fn: () => Promise<unknown>) => fn());
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {});
  const scraper = new MipymeHttpScraper(http, session);
  return { scraper, http, session };
}

describe('MipymeHttpScraper.listEmpresas', () => {
  it('parsea el combo de mipeSelEmpresa.cgi: RUT con DV y nombre sin el RUT repetido', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    const empresas = await scraper.listEmpresas();

    // Las cuatro, no dos: el SII no cierra los <option> y un parser que consuma
    // el "<" del siguiente devuelve una de cada dos, sin error. Pasó de verdad
    // contra el portal real (5 empresas en el combo, 3 devueltas).
    expect(empresas).toEqual([
      { rut: '22222222-2', nombre: 'EMPRESA DOS SPA' },
      { rut: '33333333-3', nombre: 'COMERCIAL TRES LTDA' },
      { rut: '44444444-4', nombre: 'SERVICIOS CUATRO SPA' },
      { rut: '55555555-5', nombre: 'TRANSPORTES CINCO SPA' },
    ]);
  });

  it('no navega: una sola consulta GET al CGI de selección', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    await scraper.listEmpresas();

    expect(http.get).toHaveBeenCalledTimes(1);
    expect((http.get as jest.Mock).mock.calls[0][0]).toContain('mipeSelEmpresa.cgi');
  });

  // Un combo vacío significa que el CGI no devolvió la página esperada (sesión
  // caída, rediseño, WAF). Devolver [] lo haría indistinguible de "esta persona
  // no opera ninguna empresa", que es justo el vacío ambiguo que este proyecto
  // no admite.
  it('falla si no hay ninguna opción en el combo, en vez de devolver lista vacía', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue('<html><body>sesión expirada</body></html>');

    await expect(scraper.listEmpresas()).rejects.toThrow(/no devolvió ninguna empresa/i);
  });
});

describe('MipymeHttpScraper.listDteEmitidos', () => {
  it('selecciona la empresa por POST antes de consultar el historial', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(http.postForm).toHaveBeenCalledWith(
      expect.stringContaining('mipeSelEmpresa.cgi'),
      { RUT_EMP: '33333333-3' }
    );
    // El POST tiene que ocurrir ANTES del GET del historial: sin selección, el
    // CGI responde el error de "no ha seleccionado una Empresa".
    const ordenGet = (http.get as jest.Mock).mock.invocationCallOrder;
    const ordenPost = (http.postForm as jest.Mock).mock.invocationCallOrder[0];
    expect(ordenPost).toBeGreaterThan(ordenGet[0]);
    expect(ordenPost).toBeLessThan(ordenGet[1]);
  });

  it('parsea las 8 columnas pese al <td> sin cerrar del RUT del receptor', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.documentos).toHaveLength(2);
    // Si el parser exigiera </td>, receptorRut traería la razón social y todo
    // lo demás estaría corrido un lugar. Este assert es el que fija el bug.
    expect(res.documentos[0]).toEqual({
      receptorRut: '33333333-3',
      receptorNombre: 'COMERCIAL TRES LTDA',
      tipoDte: 33,
      tipoDteNombre: 'Factura Electronica',
      folio: 244,
      fecha: '2026-07-08',
      monto: 24783,
      estado: 'Documento Emitido',
      codigo: '987654',
    });
    expect(res.documentos[1].tipoDte).toBe(61);
    expect(res.documentos[1].folio).toBe(12);
    expect(res.documentos[1].monto).toBe(119000);
  });

  it('conserva el CODIGO del link, que identifica el documento y no se puede derivar del folio', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.documentos.map(d => d.codigo)).toEqual(['987654', '987655']);
  });

  it('reporta el error propio del CGI cuando falta la selección de empresa', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(SIN_EMPRESA);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    await expect(scraper.listDteEmitidos({ empresaRut: '33333333-3' }))
      .rejects.toThrow(/no ha seleccionado una empresa/i);
  });

  it('exige que la empresa pedida esté en el combo, en vez de consultar otra', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    await expect(scraper.listDteEmitidos({ empresaRut: '99999999-9' }))
      .rejects.toThrow(/99999999-9/);
    expect(http.postForm).not.toHaveBeenCalled();
  });

  it('manda los filtros al CGI con el formato que espera, y fechas dd/mm/aaaa', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    await scraper.listDteEmitidos({
      empresaRut: '33333333-3',
      tipoDte: 33,
      fechaDesde: '2026-07-01',
      fechaHasta: '2026-07-31',
      receptorRut: '44444444-4',
      folio: 244,
      pagina: 2,
    });

    const [, params] = (http.get as jest.Mock).mock.calls[1];
    expect(params).toMatchObject({
      TPO_DOC: '33',
      FEC_DESDE: '01/07/2026',
      FEC_HASTA: '31/07/2026',
      RUT_RECP: '44444444-4',
      FOLIO: '244',
      NUM_PAG: '2',
    });
  });

  // El servicio pagina de a 100 filas y no informa el total: pedir la página 4
  // de un historial de 3 devuelve vacío, que es indistinguible de "no hay
  // documentos" si no se dice qué se pidió.
  it('informa la página consultada junto con los documentos', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.pagina).toBe(1);
  });

  it('rechaza pagina menor a 1 antes de consultar', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    await expect(scraper.listDteEmitidos({ empresaRut: '33333333-3', pagina: 0 }))
      .rejects.toThrow(/pagina/i);
    expect(http.get).not.toHaveBeenCalled();
  });
});
