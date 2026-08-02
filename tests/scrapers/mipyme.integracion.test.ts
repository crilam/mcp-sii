import { MipymeScraper } from '../../src/scrapers/mipyme';
import { Browser } from '../../src/browser';
import { SessionManager } from '../../src/session';
import { AuthStrategy, SiiConfig } from '../../src/env';

jest.mock('../../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

// A diferencia de tests/scrapers/mipyme.test.ts (que mockea SessionManager
// entero), estos tests usan un SessionManager real: sólo así se puede
// verificar que empresaRut recorre el camino completo hasta el navegador —
// ensureEmpresa → getSession → selectEmpresa/cambiarEmpresa — sin depender de
// que un mock ya "sepa" la respuesta correcta. Cubren justo el caso que el
// reviewer marcó: varias empresas, empresaRut explícito, sin SII_EMPRESA_RUT.
const config: SiiConfig = {
  rut: '99999999-9',
  strategy: AuthStrategy.Clave,
  clave: 'secreta',
  // Sin empresaRut: la única forma de resolver la empresa es el parámetro
  // por llamada.
};

const loginSnapshot = [
  '- textbox "Ingrese su RUT" [ref=e1]',
  '- textbox "Ingrese su Clave" [ref=e2]',
  '- button "Ingresar" [ref=e3]',
].join('\n');

const dosEmpresasSnapshot = [
  '- combobox [expanded=false, ref=e10]: Empresa',
  '- option "EMPRESA UNO SPA 11111111-1" [ref=e11]',
  '- option "EMPRESA DOS LTDA 22222222-2" [ref=e12]',
].join('\n');

const formSnapshot = [
  '- combobox [expanded=false, ref=e9]: Empresa',
  '- combobox [expanded=false, ref=e20]: Enero',
  '- combobox [expanded=false, ref=e21]: 2026',
  '- button "Consultar" [ref=e22]',
].join('\n');

const summarySnapshot = [
  'DTE de ventas emitidos',
  '- link "Factura Electronica (33)" [ref=e34]',
].join('\n');

function listSnapshot(folio: number): string {
  return [
    'Folio',
    `- link "${folio}" [ref=e40]`,
  ].join('\n');
}

// Fila de documento con el RUT del receptor distinto por empresa: sirve para
// confirmar que cada llamada realmente terminó operando sobre datos propios
// de la empresa pedida, no sobre una respuesta reciclada de la anterior.
function detailSnapshot(folio: number, receptorRut: string): string {
  return [
    'Total documentos',
    '      - row',
    '        - cell "1" [ref=e1]',
    `        - cell "${receptorRut}" [ref=e2]`,
    `        - cell "${folio}" [ref=e3]`,
    '        - cell "15/01/2026" [ref=e4]',
    '        - cell "15/01/2026" [ref=e5]',
    '        - cell "100.000" [ref=e6]',
    '        - cell "0" [ref=e7]',
    '        - cell "19.000" [ref=e8]',
    '        - cell "119.000" [ref=e9]',
  ].join('\n');
}

describe('MipymeScraper + SessionManager real: getDocumentoEmitido con varias empresas', () => {
  it('opera sobre la empresa pedida en cada llamada, no sobre la cacheada de la anterior', async () => {
    const browser = new MockBrowser();
    const session = new SessionManager(config, browser);
    const scraper = new MipymeScraper(browser, session);

    // Cola de snapshots consumidos en orden por cada browser.snapshot() real.
    const cola: string[] = [
      // --- Llamada 1: empresa A (11111111-1) ---
      loginSnapshot,       // authenticate() -> fillClaveForm
      dosEmpresasSnapshot, // selectEmpresa(A) durante login()
      formSnapshot,        // applyFiltrosEmitidos
      summarySnapshot,     // tras waitFor('DTE de ventas emitidos')
      listSnapshot(1001),  // tras waitFor('Folio')
      detailSnapshot(1001, '11111111-1'), // tras waitFor('Total documentos')
      // --- Llamada 2: empresa B (22222222-2), sesión ya autenticada ---
      dosEmpresasSnapshot, // cambiarEmpresa(B): sólo selectEmpresa, sin authenticate()
      formSnapshot,        // applyFiltrosEmitidos
      summarySnapshot,
      listSnapshot(2002),
      detailSnapshot(2002, '22222222-2'),
    ];
    (browser.snapshot as jest.Mock).mockImplementation(() => cola.shift());

    const docA = await scraper.getDocumentoEmitido(33, 1001, '11111111-1');
    const docB = await scraper.getDocumentoEmitido(33, 2002, '22222222-2');

    expect(docA.receptorRut).toBe('11111111-1');
    expect(docB.receptorRut).toBe('22222222-2');

    // El combo de selección de empresa se usó con cada RUT pedido, en orden:
    // primero A, después B — confirma que la segunda llamada no se quedó con
    // la empresa cacheada de la primera.
    const selectsEmpresa = (browser.select as jest.Mock).mock.calls
      .filter(([, valor]) => valor === '11111111-1' || valor === '22222222-2')
      .map(([, valor]) => valor);
    expect(selectsEmpresa.indexOf('11111111-1')).toBeLessThan(selectsEmpresa.indexOf('22222222-2'));

    // Cambiar de empresa entre llamadas no debe abrir una segunda sesión: el
    // SII bloquea el RUT que excede su límite de sesiones simultáneas
    // (01.01.190.500.720.27).
    const loginOpens = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave/.test(url));
    expect(loginOpens).toHaveLength(1);
  });
});

describe('MipymeScraper + SessionManager real: getDocumentoRecibido con varias empresas', () => {
  const tabRecibidosSnapshot = [
    '- link " DTE Emitidos" [ref=e7]',
    '- link " DTE Recibidos" [ref=e8]',
    '- heading "CONSULTA DTE RECIBIDOS"',
  ].join('\n');

  const summaryRecibidosSnapshot = [
    'CONSULTA DTE RECIBIDOS',
    'Tipo Documento',
    '- link "Factura Electronica (33)" [ref=e20]',
  ].join('\n');

  it('resuelve la empresa pedida por parámetro, sin SII_EMPRESA_RUT configurado', async () => {
    const browser = new MockBrowser();
    const session = new SessionManager(config, browser);
    const scraper = new MipymeScraper(browser, session);

    const cola: string[] = [
      loginSnapshot,
      dosEmpresasSnapshot,       // selectEmpresa(B) durante login()
      tabRecibidosSnapshot,      // navegarATabRecibidos
      formSnapshot,              // applyFiltrosRecibidos
      summaryRecibidosSnapshot,  // tras waitForAny
      listSnapshot(3003),        // tras waitFor('Folio')
      detailSnapshot(3003, '22222222-2'), // tras waitFor('Total documentos')
    ];
    (browser.snapshot as jest.Mock).mockImplementation(() => cola.shift());

    const doc = await scraper.getDocumentoRecibido(33, 3003, '22222222-2', '22222222-2');

    expect(doc.emisorRut).toBe('22222222-2');
    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '22222222-2');
  });
});
