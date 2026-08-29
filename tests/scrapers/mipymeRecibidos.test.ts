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
const RECIBIDOS = fixture('mipyme-historial-recibidos.html');
const SIN_EMPRESA = fixture('mipyme-sin-empresa.html');

function armar() {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.conEmpresaExclusiva as jest.Mock) = jest.fn((fn: () => Promise<unknown>) => fn());
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {});
  const scraper = new MipymeHttpScraper(http, session);
  return { scraper, http, session };
}

function conHistorial(html: string = RECIBIDOS) {
  const { scraper, http, session } = armar();
  (http.get as jest.Mock)
    .mockResolvedValueOnce(SEL_EMPRESA)
    .mockResolvedValueOnce(html);
  (http.postForm as jest.Mock).mockResolvedValue('<html></html>');
  return { scraper, http, session };
}

describe('MipymeHttpScraper.listDteRecibidos', () => {
  // El CGI de recibidos NO se adivinó: el menú lleva a mipeLaunchPage.cgi, que
  // asigna el destino por JavaScript. Es `...Rcp.cgi`, no `...Rec.cgi`.
  it('consulta mipeAdminDocsRcp.cgi, que es el CGI del lado recibido', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(http.get).toHaveBeenLastCalledWith(
      expect.stringContaining('mipeAdminDocsRcp.cgi'), expect.any(Object));
  });

  it('selecciona la empresa por POST antes de consultar', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(http.postForm).toHaveBeenCalledWith(
      expect.stringContaining('mipeSelEmpresa.cgi'), { RUT_EMP: '33333333-3' });

    // Sin selección previa el CGI responde el error de "no ha seleccionado una
    // Empresa", así que el orden es parte del contrato y no un detalle.
    const ordenGet = (http.get as jest.Mock).mock.invocationCallOrder;
    const ordenPost = (http.postForm as jest.Mock).mock.invocationCallOrder[0];
    expect(ordenPost).toBeGreaterThan(ordenGet[0]);
    expect(ordenPost).toBeLessThan(ordenGet[1]);
  });

  it('parsea las 8 columnas con el EMISOR como contraparte', async () => {
    const { scraper } = conHistorial();

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(res.documentos).toHaveLength(3);
    expect(res.documentos[0]).toEqual({
      emisorRut: '11111111-1',
      emisorNombre: 'ASESORÍAS GENÉRICAS LTDA',
      tipoDte: 34,
      tipoDteNombre: 'Factura Exenta Electronica',
      folio: 205,
      fecha: '2023-07-19',
      monto: 592370,
      estado: 'DTE Recibido Sin Reparos',
      codigo: '1111111111',
    });
  });

  // Medido en vivo: 3 de 100 documentos venían con tipoDte=0 porque el portal
  // escribe "Guia de Despacho Electronica" y el catálogo sólo tenía "Guia de
  // Despacho". Un consumidor que filtre por tipo los pierde sin enterarse.
  it('reconoce el tipo con el sufijo "Electronica" que usa el portal', async () => {
    const { scraper } = conHistorial();

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    const guia = res.documentos.find(d => d.folio === 412)!;
    expect(guia.tipoDteNombre).toBe('Guia de Despacho Electronica');
    expect(guia.tipoDte).toBe(52);
  });

  it('conserva el CODIGO del link, que no se deriva del folio', async () => {
    const { scraper } = conHistorial();

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(res.documentos.map(d => d.codigo))
      .toEqual(['1111111111', '2222222222', '3333333333']);
  });

  it('cuenta las páginas por los enlaces de paginación', async () => {
    const { scraper } = conHistorial();

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(res.totalPaginas).toBe(3);
    expect(res.pagina).toBe(1);
    expect(res.empresaRut).toBe('33333333-3');
  });

  // El filtro por contraparte es por EMISOR y el portal lo llama `RUT_EMI`: con
  // el nombre de emitidos (`RUT_RECP`) el CGI ignora el filtro y devuelve TODO,
  // que se lee como "este emisor mandó cien documentos".
  it('manda el filtro de emisor como RUT_EMI', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({ empresaRut: '33333333-3', emisorRut: '11111111-1' });

    expect(http.get).toHaveBeenLastCalledWith(
      expect.any(String), expect.objectContaining({ RUT_EMI: '11111111-1' }));
  });

  it('traduce las fechas al formato del portal', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({
      empresaRut: '33333333-3', fechaDesde: '2024-01-15', fechaHasta: '2024-02-28',
    });

    expect(http.get).toHaveBeenLastCalledWith(expect.any(String),
      expect.objectContaining({ FEC_DESDE: '15/01/2024', FEC_HASTA: '28/02/2024' }));
  });

  it('pide la página que se le pasa', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({ empresaRut: '33333333-3', pagina: 3 });

    expect(http.get).toHaveBeenLastCalledWith(expect.any(String),
      expect.objectContaining({ NUM_PAG: '3' }));
  });

  it.each([0, -1, 1.5])('rechaza una página inválida (%p)', async (pagina) => {
    const { scraper } = conHistorial();

    await expect(scraper.listDteRecibidos({ empresaRut: '33333333-3', pagina }))
      .rejects.toThrow(/pagina debe ser un entero/);
  });

  it('reporta el error propio del CGI cuando falta la selección de empresa', async () => {
    const { scraper } = conHistorial(SIN_EMPRESA);

    await expect(scraper.listDteRecibidos({ empresaRut: '33333333-3' }))
      .rejects.toThrow(/no ha seleccionado una empresa/i);
  });

  // Una fila que ES de datos y que el parser no supo leer no se saltea en
  // silencio: cien documentos convertidos en lista vacía se leen como "esta
  // empresa no recibió nada", que es el vacío ambiguo de siempre.
  it('falla si hay filas de datos que no puede interpretar', async () => {
    const roto = `<table><tbody><tr>
      <td><a href="/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=999">ver</a></td>
      <td>11111111-1</td><td>ALGUIEN</td>
    </tr></tbody></table>`;
    const { scraper } = conHistorial(roto);

    await expect(scraper.listDteRecibidos({ empresaRut: '33333333-3' }))
      .rejects.toThrow(/no pudo interpretar/);
  });

  it('una tabla sin filas de datos devuelve vacío sin fallar', async () => {
    const { scraper } = conHistorial('<table><tbody></tbody></table>');

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(res.documentos).toEqual([]);
    // Sin enlaces de paginación no se puede afirmar cuántas páginas hay, y
    // decir "1" haría parecer completo un historial que no se pudo leer.
    expect(res.totalPaginas).toBeNull();
  });
});
