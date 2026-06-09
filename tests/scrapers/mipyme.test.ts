import { MipymeScraper } from '../../src/scrapers/mipyme';
import { Browser } from '../../src/browser';
import { SessionManager } from '../../src/session';

jest.mock('../../src/browser');
jest.mock('../../src/session');

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// Snapshots en formato accessibility tree (nuevo portal SII Angular)
const formSnapshot = [
  '- combobox [expanded=false, ref=e9]: Empresa',
  '- combobox [expanded=false, ref=e10]: Enero',
  '- combobox [expanded=false, ref=e11]: 2026',
  '- button "Consultar" [ref=e12]',
].join('\n');

const summarySnapshot = [
  'DTE de ventas emitidos',
  '- link "Factura Electronica (33)" [ref=e34]',
].join('\n');

// Fila de documento individual con 12 celdas (formato accessibility tree)
const docSnapshot = [
  '      - row',
  '        - cell "1" [ref=e1]',
  '        - cell "33333333-3" [ref=e2]',
  '        - cell "1001" [ref=e3]',
  '        - cell "15/01/2026" [ref=e4]',
  '        - cell "15/01/2026" [ref=e5]',
  '        - cell "100.000" [ref=e6]',
  '        - cell "0" [ref=e7]',
  '        - cell "19.000" [ref=e8]',
  '        - cell "119.000" [ref=e9]',
  '        - cell',
  '        - cell " Publicar" [ref=e11]',
  '        - cell',
].join('\n');

describe('MipymeScraper.listEmpresas', () => {
  it('retorna lista de empresas disponibles desde snapshot', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: '11111111-1' });
    (browser.snapshot as jest.Mock).mockReturnValue(
      '- option "11111111-1" [ref=e11]\n- option "22222222-2" [ref=e12]'
    );

    const scraper = new MipymeScraper(browser, session);
    const empresas = await scraper.listEmpresas();

    expect(empresas).toHaveLength(2);
    expect(empresas[0]).toEqual({ rut: '11111111-1', nombre: '11111111-1' });
    expect(empresas[1]).toEqual({ rut: '22222222-2', nombre: '22222222-2' });
  });

  it('retorna empresa de sesion si snapshot no tiene opciones', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: '11111111-1' });
    (browser.snapshot as jest.Mock).mockReturnValue('sin opciones aqui');

    const scraper = new MipymeScraper(browser, session);
    const empresas = await scraper.listEmpresas();

    expect(empresas).toHaveLength(1);
    expect(empresas[0].rut).toBe('11111111-1');
  });
});

describe('MipymeScraper.listDocumentosEmitidos', () => {
  it('retorna documentos emitidos con filtros', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: 'EMP A' });
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(formSnapshot)   // applyFiltrosEmitidos
      .mockReturnValueOnce(summarySnapshot) // summary tras waitFor
      .mockReturnValueOnce(docSnapshot);    // detalle tras waitFor Folio

    const scraper = new MipymeScraper(browser, session);
    const docs = await scraper.listDocumentosEmitidos({ fechaDesde: '2026-01-01' });

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]).toMatchObject({
      folio: 1001,
      tipoDte: 33,
      fecha: '15/01/2026',
      receptorRut: '33333333-3',
    });
  });
});

// Fila de documento recibido con 12 celdas (formato accessibility tree)
const docRecibidoSnapshot = [
  '      - row',
  '        - cell "1" [ref=e1]',
  '        - cell "33333333-3" [ref=e2]',
  '        - cell "2001" [ref=e3]',
  '        - cell "10/01/2026" [ref=e4]',
  '        - cell "10/01/2026" [ref=e5]',
  '        - cell "200.000" [ref=e6]',
  '        - cell "0" [ref=e7]',
  '        - cell "38.000" [ref=e8]',
  '        - cell "238.000" [ref=e9]',
  '        - cell "Recibido" [ref=e10]',
  '        - cell',
  '        - cell',
].join('\n');

describe('MipymeScraper.listDocumentosRecibidos', () => {
  it('retorna documentos recibidos con filtros', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: 'EMP A' });
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(formSnapshot)        // applyFiltrosRecibidos
      .mockReturnValueOnce(docRecibidoSnapshot); // snapshot tras waitFor Folio

    const scraper = new MipymeScraper(browser, session);
    const docs = await scraper.listDocumentosRecibidos({ fechaDesde: '2026-01-01' });

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]).toMatchObject({
      folio: 2001,
      emisorRut: '33333333-3',
      fecha: '10/01/2026',
      total: 238000,
    });
  });
});

describe('MipymeScraper.withReauth', () => {
  it('re-autentica y reintenta si falla con error de sesion', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: 'EMP A' });
    (session.invalidate as jest.Mock).mockImplementation(() => {});
    // snapshot vacío hace que parseSummaryTypeLinks retorne [] y el método retorne []
    (browser.snapshot as jest.Mock).mockReturnValue(formSnapshot);

    let callCount = 0;
    (browser.open as jest.Mock).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('session expirada');
    });

    const scraper = new MipymeScraper(browser, session);
    await scraper.listDocumentosEmitidos({ fechaDesde: '2026-01-01' });

    expect(session.invalidate).toHaveBeenCalledTimes(1);
    // ensureEmpresa(1) + withReauth re-auth(1) + ensureEmpresa retry(1) + applyFiltros(1) = 4
    expect(session.getSession).toHaveBeenCalledTimes(4);
  });

  it('propaga errores que no son de sesion', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: 'EMP A' });
    (browser.open as jest.Mock).mockImplementation(() => {
      throw new Error('Error de red inesperado');
    });

    const scraper = new MipymeScraper(browser, session);
    await expect(scraper.listDocumentosEmitidos({})).rejects.toThrow('Error de red inesperado');
    expect(session.invalidate).not.toHaveBeenCalled();
  });
});
