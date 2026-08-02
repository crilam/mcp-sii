import { MipymeScraper } from '../../src/scrapers/mipyme';
import { Browser } from '../../src/browser';
import { SessionManager } from '../../src/session';

jest.mock('../../src/browser');
jest.mock('../../src/session');

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// El automock devuelve undefined en cada método, y conEmpresaExclusiva tiene
// que EJECUTAR la operación que recibe. La exclusión real se prueba en
// tests/session.exclusion.test.ts; acá sólo se necesita el paso a través.
beforeEach(() => {
  MockSession.prototype.conEmpresaExclusiva = jest.fn(
    (fn: () => Promise<unknown>) => fn()
  ) as jest.Mock;
});

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
  it('retorna lista de empresas con nombre y rut desde portal mipyme', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.listEmpresasDisponibles as jest.Mock).mockResolvedValue([
      { rut: '11111111-1', nombre: 'EMPRESA UNO SPA' },
      { rut: '22222222-2', nombre: 'EMPRESA DOS LTDA' },
    ]);

    const scraper = new MipymeScraper(browser, session);
    const empresas = await scraper.listEmpresas();

    expect(empresas).toHaveLength(2);
    expect(empresas[0]).toEqual({ rut: '11111111-1', nombre: 'EMPRESA UNO SPA' });
    expect(empresas[1]).toEqual({ rut: '22222222-2', nombre: 'EMPRESA DOS LTDA' });
  });

  it('no exige empresa seleccionada: no llama a getSession cuando hay empresas', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.listEmpresasDisponibles as jest.Mock).mockResolvedValue([
      { rut: '11111111-1', nombre: 'EMPRESA UNO SPA' },
      { rut: '22222222-2', nombre: 'EMPRESA DOS LTDA' },
    ]);
    (session.getSession as jest.Mock).mockRejectedValue(
      new Error('Esta persona opera 2 empresas. Configura SII_EMPRESA_RUT')
    );

    const scraper = new MipymeScraper(browser, session);
    await expect(scraper.listEmpresas()).resolves.toHaveLength(2);
    expect(session.getSession).not.toHaveBeenCalled();
  });

  it('retorna empresa de sesion si el portal no lista opciones', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.listEmpresasDisponibles as jest.Mock).mockResolvedValue([]);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: '11111111-1' });

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

const tabRecibidosSnapshot = [
  '- link " DTE Emitidos" [ref=e7]',
  '- link " DTE Recibidos" [ref=e8]',
  '- link " Descargas Diferidas" [ref=e9]',
  '- heading "CONSULTA DTE RECIBIDOS"',
].join('\n');

const summaryRecibidosSnapshot = [
  'CONSULTA DTE RECIBIDOS',
  'Tipo Documento',
  '- link "Factura Electronica (33)" [ref=e20]',
].join('\n');

describe('MipymeScraper.listDocumentosRecibidos', () => {
  it('retorna documentos recibidos con filtros', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: 'EMP A' });
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(tabRecibidosSnapshot) // navegarATabRecibidos: findRef tab
      .mockReturnValueOnce(formSnapshot)          // applyFiltrosRecibidos
      .mockReturnValueOnce(summaryRecibidosSnapshot) // summary tras waitForAny
      .mockReturnValueOnce(docRecibidoSnapshot);  // detalle tras waitFor Folio

    const scraper = new MipymeScraper(browser, session);
    const docs = await scraper.listDocumentosRecibidos({ fechaDesde: '2026-01-01' });

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]).toMatchObject({
      folio: 2001,
      tipoDte: 33,
      emisorRut: '33333333-3',
      fecha: '10/01/2026',
      total: 238000,
    });
  });
});

describe('MipymeScraper: empresa_rut por llamada llega hasta getSession', () => {
  // Bug original: ensureEmpresa llamaba session.getSession() sin argumentos,
  // así que el empresaRut que ya recibía la tool se perdía antes de resolver
  // la sesión, y getSession() reventaba con "opera varias empresas" aunque
  // el llamador hubiera pasado un empresa_rut válido.
  it('listDocumentosEmitidos pasa el empresaRut de filtros a session.getSession', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '22222222-2', empresaNombre: 'EMP B' });
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(formSnapshot)
      .mockReturnValueOnce(summarySnapshot)
      .mockReturnValueOnce(docSnapshot);

    const scraper = new MipymeScraper(browser, session);
    await scraper.listDocumentosEmitidos({ empresaRut: '22222222-2' });

    expect(session.getSession).toHaveBeenCalledWith('22222222-2');
  });

  it('emitirDte pasa el empresaRut a session.getSession vía ensureMipymePortalEmpresa', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '22222222-2', empresaNombre: 'EMPRESA B' });
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(mipymePortalSnapshot)
      .mockReturnValueOnce(emisionFormSnapshot)
      .mockReturnValueOnce(emisionFormSnapshot)
      .mockReturnValueOnce(emisionFormSnapshot)
      .mockReturnValueOnce(emisionConfirmSnapshot)
      .mockReturnValueOnce(emisionSuccessSnapshot);

    const scraper = new MipymeScraper(browser, session);
    await scraper.emitirDte({
      empresaRut: '22222222-2',
      tipoDte: 33,
      receptorRut: '33333333-3',
      receptorDv: '1',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100000 }],
    });

    expect(session.getSession).toHaveBeenCalledWith('22222222-2');
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
    // ensureEmpresa(1) + ensureEmpresa retry(1) + applyFiltros retry(1) = 3.
    // withReauth ya no llama getSession() suelto antes del reintento: fn()
    // vuelve a pasar por ensureEmpresa(empresaRut) al reintentar, así que ese
    // llamado extra era redundante (y, con varias empresas sin
    // SII_EMPRESA_RUT, reventaba "opera N empresas" enmascarando el error real).
    expect(session.getSession).toHaveBeenCalledTimes(3);
  });

  // Bug cerrado: withReauth llamaba session.getSession() SIN argumento antes
  // de reintentar. Con varias empresas y sin SII_EMPRESA_RUT, ese llamado
  // suelto revienta "opera N empresas" aunque la llamada original sí haya
  // pasado empresa_rut — enmascarando el error de sesión expirada y
  // perdiendo el reintento. Se simula ese mock real: getSession() sin
  // argumento rechaza, getSession(rut) resuelve.
  it('reintenta sobre la empresa pedida sin disparar el error de selección multi-empresa', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockImplementation((empresaRut?: string) => {
      if (!empresaRut) {
        return Promise.reject(new Error('Esta persona opera 5 empresas. Configura SII_EMPRESA_RUT con uno de: ...'));
      }
      return Promise.resolve({ empresaRut, empresaNombre: 'EMPRESA B' });
    });
    (session.invalidate as jest.Mock).mockImplementation(() => {});
    (browser.snapshot as jest.Mock).mockReturnValue(formSnapshot);

    let callCount = 0;
    (browser.open as jest.Mock).mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('session expirada');
    });

    const scraper = new MipymeScraper(browser, session);
    const docs = await scraper.listDocumentosEmitidos({ empresaRut: '22222222-2', fechaDesde: '2026-01-01' });

    expect(docs).toEqual([]);
    expect(session.invalidate).toHaveBeenCalledTimes(1);
    // Todos los getSession() de esta llamada deben llevar el empresaRut pedido.
    for (const [rut] of (session.getSession as jest.Mock).mock.calls) {
      expect(rut).toBe('22222222-2');
    }
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

// ---- Snapshots para portal mipyme CGI ----
const mipymePortalSnapshot = [
  '- combobox [ref=e5]: 11111111-1',
  '  - option "EMPRESA A 11111111-1" [ref=e11]',
  '- button "Ingresar" [ref=e6]',
].join('\n');

// Cada fila del historial tiene columna "Ver" (- cell [ref=eN]) que el parser ignora
// porque no tiene comillas, seguida de 7 columnas con texto
const mipymeHistorialSnapshot = [
  'Receptor RUT',
  '      - row',
  '        - cell [ref=e1]',
  '        - cell "33333333-3" [ref=e2]',
  '        - cell "EMPRESA A" [ref=e3]',
  '        - cell "Factura Electronica" [ref=e4]',
  '        - cell "1001" [ref=e5]',
  '        - cell "15/01/2026" [ref=e6]',
  '        - cell "119.000" [ref=e7]',
  '        - cell "Vigente" [ref=e8]',
].join('\n');

describe('MipymeScraper.listMipymeDteEmitidos', () => {
  it('retorna documentos del historial mipyme CGI con filtros', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: 'EMPRESA A' });
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(mipymePortalSnapshot)    // ensureMipymePortalEmpresa
      .mockReturnValueOnce(mipymeHistorialSnapshot); // listMipymeDteEmitidos tras waitForAny

    const scraper = new MipymeScraper(browser, session);
    const docs = await scraper.listMipymeDteEmitidos({ fechaDesde: '2026-01-01' });

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]).toMatchObject({
      folio: 1001,
      tipoDte: 33,
      tipoDteNombre: 'Factura Electronica',
      receptorRut: '33333333-3',
      receptorNombre: 'EMPRESA A',
      monto: 119000,
      estado: 'Vigente',
    });
  });

  it('retorna [] si el portal indica "No existen documentos"', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: 'EMPRESA A' });
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(mipymePortalSnapshot)
      .mockReturnValueOnce('No existen documentos');

    const scraper = new MipymeScraper(browser, session);
    const docs = await scraper.listMipymeDteEmitidos({});
    expect(docs).toEqual([]);
  });
});

// Snapshots para flujo de emisión DTE
const emisionFormSnapshot = [
  '- textbox "RUT Receptor" [ref=e10]',
  '- textbox "DV" [ref=e11]',
  '- textbox "Descripción" [ref=e20]',
  '- spinbutton "Cantidad" [ref=e21]',
  '- spinbutton "Precio Unitario" [ref=e22]',
  '- button "Agrega linea de Detalle" [ref=e23]',
  '- button "Validar y visualizar" [ref=e30]',
].join('\n');

const emisionConfirmSnapshot = [
  'Folio: 1234',
  'Total: 119.000',
  '- button "Emitir" [ref=e40]',
].join('\n');

const emisionSuccessSnapshot = [
  'Folio 1234',
  'Receptor: 33333333-3',
  'Total: 119.000',
].join('\n');

describe('MipymeScraper.emitirDte', () => {
  it('navega el portal, llena el formulario y retorna folio emitido', async () => {
    const browser = new MockBrowser();
    const session = new MockSession({} as any, browser);
    (session.getSession as jest.Mock).mockResolvedValue({ empresaRut: '11111111-1', empresaNombre: 'EMPRESA A' });
    (browser.snapshot as jest.Mock)
      .mockReturnValueOnce(mipymePortalSnapshot)    // ensureMipymePortalEmpresa
      .mockReturnValueOnce(emisionFormSnapshot)     // fill receptor
      .mockReturnValueOnce(emisionFormSnapshot)     // fill linea
      .mockReturnValueOnce(emisionFormSnapshot)     // snapshot para validar
      .mockReturnValueOnce(emisionConfirmSnapshot)  // tras waitFor('Emitir')
      .mockReturnValueOnce(emisionSuccessSnapshot); // tras waitFor('Folio')

    const scraper = new MipymeScraper(browser, session);
    const result = await scraper.emitirDte({
      tipoDte: 33,
      receptorRut: '33333333-3',
      receptorDv: '1',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100000 }],
    });

    expect(result.folio).toBe(1234);
    expect(result.tipoDte).toBe(33);
    expect(browser.fill).toHaveBeenCalledWith(expect.any(String), '33333333-3');
    expect(browser.fill).toHaveBeenCalledWith(expect.any(String), '1');
  });
});
