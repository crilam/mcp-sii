import { MipymeScraper } from '../../src/scrapers/mipyme';
import { Browser } from '../../src/browser';
import { SessionManager } from '../../src/session';
import { AuthStrategy, SiiConfig } from '../../src/env';

jest.mock('../../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

// A diferencia de tests/scrapers/mipyme.test.ts (que mockea SessionManager
// entero), estos tests usan un SessionManager real: sólo así se puede
// verificar que empresaRut recorre el camino completo hasta el navegador —
// ensureMipymePortalEmpresa → getSession → selectEmpresa/cambiarEmpresa — sin
// depender de que un mock ya "sepa" la respuesta correcta. Cubren el caso de
// varias empresas con empresaRut explícito y sin SII_EMPRESA_RUT.
//
// Antes ejercitaban getDocumentoEmitido/getDocumentoRecibido. Esos métodos se
// borraron: apuntaban a `consemitidosinternetui`, que ya se consulta por HTTP
// en DteScraper, y ninguna tool los llamaba. La garantía que verificaban —que
// dos llamadas con empresas distintas no se contaminan y no abren una segunda
// sesión— es del camino de empresa, no de esos métodos, así que se conserva
// acá sobre listMipymeDteEmitidos, que sigue usando el navegador.
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

// Página de selección del portal mipyme (mipeSelEmpresa.cgi) que abre
// ensureMipymePortalEmpresa antes de consultar el historial.
const portalSnapshot = [
  '- combobox [expanded=false, ref=e30]: Empresa',
  '- button "Ingresar" [ref=e31]',
].join('\n');

// Fila del historial con el RUT del receptor distinto por empresa: sirve para
// confirmar que cada llamada realmente terminó operando sobre datos propios de
// la empresa pedida, no sobre una respuesta reciclada de la anterior.
function historialSnapshot(folio: number, receptorRut: string): string {
  return [
    'Receptor RUT',
    '      - row',
    `        - cell "${receptorRut}" [ref=e1]`,
    '        - cell "CLIENTE SPA" [ref=e2]',
    '        - cell "Factura Electronica" [ref=e3]',
    `        - cell "${folio}" [ref=e4]`,
    '        - cell "2026-01-15" [ref=e5]',
    '        - cell "119000" [ref=e6]',
    '        - cell "Documento Emitido" [ref=e7]',
  ].join('\n');
}

describe('MipymeScraper + SessionManager real: listMipymeDteEmitidos con varias empresas', () => {
  it('opera sobre la empresa pedida en cada llamada, no sobre la cacheada de la anterior', async () => {
    const browser = new MockBrowser();
    const session = new SessionManager(config, browser);
    const scraper = new MipymeScraper(browser, session);

    // Cola de snapshots consumidos en orden por cada browser.snapshot() real.
    const cola: string[] = [
      // --- Llamada 1: empresa A (11111111-1) ---
      loginSnapshot,       // authenticate() -> fillClaveForm
      dosEmpresasSnapshot, // selectEmpresa(A) durante login()
      portalSnapshot,      // ensureMipymePortalEmpresa
      historialSnapshot(1001, '11111111-1'),
      // --- Llamada 2: empresa B (22222222-2), sesión ya autenticada ---
      dosEmpresasSnapshot, // cambiarEmpresa(B): sólo selectEmpresa, sin authenticate()
      portalSnapshot,
      historialSnapshot(2002, '22222222-2'),
    ];
    (browser.snapshot as jest.Mock).mockImplementation(() => cola.shift());

    const docsA = await scraper.listMipymeDteEmitidos({ empresaRut: '11111111-1' });
    const docsB = await scraper.listMipymeDteEmitidos({ empresaRut: '22222222-2' });

    expect(docsA[0].receptorRut).toBe('11111111-1');
    expect(docsA[0].folio).toBe(1001);
    expect(docsB[0].receptorRut).toBe('22222222-2');
    expect(docsB[0].folio).toBe(2002);

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

  it('resuelve la empresa pedida por parámetro, sin SII_EMPRESA_RUT configurado', async () => {
    const browser = new MockBrowser();
    const session = new SessionManager(config, browser);
    const scraper = new MipymeScraper(browser, session);

    const cola: string[] = [
      loginSnapshot,
      dosEmpresasSnapshot, // selectEmpresa(B) durante login()
      portalSnapshot,
      historialSnapshot(3003, '22222222-2'),
    ];
    (browser.snapshot as jest.Mock).mockImplementation(() => cola.shift());

    const docs = await scraper.listMipymeDteEmitidos({ empresaRut: '22222222-2' });

    expect(docs[0].receptorRut).toBe('22222222-2');
    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '22222222-2');
  });
});
