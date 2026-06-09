import { MipymeScraper } from '../../src/scrapers/mipyme';
import { Browser } from '../../src/browser';
import { SessionManager } from '../../src/session';

jest.mock('../../src/browser');
jest.mock('../../src/session');

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

describe('MipymeScraper.listEmpresas', () => {
  it('retorna lista de empresas disponibles', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111', empresaNombre: 'EMPRESA A' });
    (browser.snapshot as jest.Mock).mockReturnValue(
      '[option "EMPRESA A" value="11111111"] [option "EMPRESA B" value="22222222"]'
    );

    const scraper = new MipymeScraper(browser, session);
    const empresas = await scraper.listEmpresas();

    expect(empresas).toHaveLength(2);
    expect(empresas[0]).toEqual({ rut: '11111111', nombre: 'EMPRESA A' });
    expect(empresas[1]).toEqual({ rut: '22222222', nombre: 'EMPRESA B' });
  });
});

describe('MipymeScraper.listDocumentosEmitidos', () => {
  it('retorna documentos emitidos con filtros', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111', empresaNombre: 'EMP A' });
    (browser.snapshot as jest.Mock).mockReturnValue(
      '[row] [cell "33"] [cell "1001"] [cell "2026-01-15"] [cell "CLIENTE SPA"] [cell "33333333-3"] [cell "100000"] [cell "19000"] [cell "119000"] [cell "DOK"] [/row]'
    );

    const scraper = new MipymeScraper(browser, session);
    const docs = await scraper.listDocumentosEmitidos({ fechaDesde: '2026-01-01', fechaHasta: '2026-01-31' });

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]).toMatchObject({
      folio: 1001,
      tipoDte: 33,
      fecha: '2026-01-15',
      receptorNombre: 'CLIENTE SPA',
    });
  });
});

describe('MipymeScraper.withReauth', () => {
  it('re-autentica y reintenta si falla con error de sesion', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111', empresaNombre: 'EMP A' });
    (session.invalidate as jest.Mock).mockImplementation(() => {});

    let callCount = 0;
    (browser.snapshot as jest.Mock).mockReturnValue(
      '[row] [cell "33"] [cell "1001"] [cell "2026-01-15"] [cell "CLIENTE SPA"] [cell "33333333-3"] [cell "100000"] [cell "19000"] [cell "119000"] [cell "DOK"] [/row]'
    );
    (browser.open as jest.Mock).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('session expirada');
    });

    const scraper = new MipymeScraper(browser, session);
    const docs = await scraper.listDocumentosEmitidos({ fechaDesde: '2026-01-01' });

    expect(session.invalidate).toHaveBeenCalledTimes(1);
    // getSession is called: once by ensureEmpresa on first attempt, once by withReauth
    // during re-auth, and once again by ensureEmpresa on the retry — total 3
    expect(session.getSession).toHaveBeenCalledTimes(3);
  });

  it('propaga errores que no son de sesion', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111', empresaNombre: 'EMP A' });
    (browser.open as jest.Mock).mockImplementation(() => {
      throw new Error('Error de red inesperado');
    });

    const scraper = new MipymeScraper(browser, session);
    await expect(scraper.listDocumentosEmitidos({})).rejects.toThrow('Error de red inesperado');
    expect(session.invalidate).not.toHaveBeenCalled();
  });
});
