import { BienesRaicesScraper } from '../../src/scrapers/bienesRaices';
import { Browser } from '../../src/browser';
import { SessionManager } from '../../src/session';

jest.mock('../../src/browser');
jest.mock('../../src/session');

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// Estructura real del portal www2.sii.cl/vica/Menu/BienesRaices con datos ficticios.
const snapshot = [
  '- generic',
  '  - generic',
  '    - generic',
  '      - heading "CONSULTAR MIS BIENES RAÍCES" [level=1, ref=e3]',
  '      - generic',
  '        - StaticText "Total bienes"',
  '        - LineBreak "\\n"',
  '        - StaticText "raíces"',
  '        - LineBreak "\\n"',
  '        - StaticText "3"',
  '      - StaticText "ℹ"',
  '      - generic [ref=e5] clickable [cursor:pointer]',
  '        - generic',
  '          - StaticText "Solicitudes"',
  '          - LineBreak "\\n"',
  '          - StaticText "En curso y otras/resueltas"',
  '          - LineBreak "\\n"',
  '          - StaticText "2 / 1"',
  '      - link "Notificaciones de bienes raíces 8" [ref=e27]',
  '        - generic',
  '          - StaticText "Notificaciones"',
  '          - LineBreak "\\n"',
  '          - StaticText "de bienes raíces"',
  '          - LineBreak "\\n"',
  '          - StaticText "8"',
  '      - generic [ref=e6] clickable [cursor:pointer]',
  '        - generic',
  '          - StaticText "Sobretasa"',
  '          - LineBreak "\\n"',
  '          - StaticText "Bienes inmuebles"',
  '          - LineBreak "\\n"',
  '          - StaticText "SI"',
  '      - generic [ref=e7] clickable [cursor:pointer]',
  '        - generic',
  '          - StaticText "Beneficio"',
  '          - LineBreak "\\n"',
  '          - StaticText "Adulto Mayor"',
  '          - LineBreak "\\n"',
  '          - StaticText "NO"',
  '      - heading "LISTADO DE BIENES RAÍCES" [level=1, ref=e4]',
  '      - table',
  '        - rowgroup',
  '          - row',
  '            - columnheader "Comuna " [ref=e273] clickable [cursor:pointer]',
  '            - columnheader "ROL ℹ" [ref=e274] clickable [cursor:pointer]',
  '        - row',
  '          - cell',
  '            - LabelText',
  '              - checkbox [checked=false, ref=e442]',
  '          - cell "SANTIAGO" [ref=e72]',
  '          - cell "00632-00244" [ref=e73]',
  '            - link "00632-00244" [ref=e285]',
  '          - cell "CALLE FICTICIA 100 DP 101" [ref=e74]',
  '          - cell "HABITACIONAL" [ref=e75]',
  '          - cell "Descargar formulario de F2890 6603" [ref=e76]',
  '          - cell "5204" [ref=e77]',
  '          - cell "2019" [ref=e78]',
  '          - cell "100.00 %" [ref=e79]',
  '          - cell "$ 51.230.998" [ref=e80]',
  '          - cell "VER" [ref=e81]',
  '          - cell',
  '        - row',
  '          - cell',
  '            - LabelText',
  '              - checkbox [checked=false, ref=e443]',
  '          - cell "CURACAVI" [ref=e82]',
  '          - cell "00103-00830" [ref=e83]',
  '          - cell "PARCELA FICTICIA 36 B" [ref=e84]',
  '          - cell "SITIO ERIAZO" [ref=e85]',
  '          - cell "Descargar formulario de F2890 1200" [ref=e86]',
  '          - cell "980" [ref=e87]',
  '          - cell "2021" [ref=e88]',
  '          - cell "50.50 %" [ref=e89]',
  '          - cell "$ 31.800.154" [ref=e90]',
  '          - cell "VER" [ref=e91]',
  '          - cell',
].join('\n');

function makeScraper() {
  const browser = new MockBrowser();
  const session = new MockSession({} as any, browser);
  (session.authenticateOnly as jest.Mock).mockResolvedValue(undefined);
  (browser.snapshot as jest.Mock).mockReturnValue(snapshot);
  return { browser, session, scraper: new BienesRaicesScraper(browser, session) };
}

describe('BienesRaicesScraper.listBienesRaices', () => {
  it('parsea el resumen del encabezado', async () => {
    const { scraper } = makeScraper();
    const { resumen } = await scraper.listBienesRaices();

    expect(resumen).toEqual({
      totalBienesRaices: 3,
      solicitudesEnCurso: 2,
      solicitudesResueltas: 1,
      notificaciones: 8,
      afectoSobretasa: true,
      beneficioAdultoMayor: false,
    });
  });

  it('ignora el icono decorativo que cierra el tile al leer su valor', async () => {
    const { scraper } = makeScraper();
    const { resumen } = await scraper.listBienesRaices();

    // El tile de total termina en un StaticText "ℹ" que no es el valor.
    expect(resumen.totalBienesRaices).toBe(3);
  });

  it('parsea el listado de propiedades', async () => {
    const { scraper } = makeScraper();
    const { propiedades } = await scraper.listBienesRaices();

    expect(propiedades).toHaveLength(2);
    expect(propiedades[0]).toEqual({
      comuna: 'SANTIAGO',
      rol: '00632-00244',
      direccion: 'CALLE FICTICIA 100 DP 101',
      destino: 'HABITACIONAL',
      fojas: '6603',
      numero: '5204',
      anio: '2019',
      porcentajeDerechos: 100,
      avaluoFiscal: 51230998,
    });
  });

  it('interpreta el punto como decimal en el porcentaje y como miles en el avalúo', async () => {
    const { scraper } = makeScraper();
    const { propiedades } = await scraper.listBienesRaices();

    expect(propiedades[1].porcentajeDerechos).toBe(50.5);
    expect(propiedades[1].avaluoFiscal).toBe(31800154);
  });

  it('ignora las filas de encabezado que no tienen ROL', async () => {
    const { scraper } = makeScraper();
    const { propiedades } = await scraper.listBienesRaices();

    expect(propiedades.every(p => /^\d+-\d+$/.test(p.rol))).toBe(true);
  });

  it('autentica sin seleccionar empresa', async () => {
    const { scraper, session } = makeScraper();
    await scraper.listBienesRaices();

    expect(session.authenticateOnly).toHaveBeenCalled();
    expect(session.getSession).not.toHaveBeenCalled();
  });

  it('espera a que la SPA renderice antes de leer el snapshot', async () => {
    const { scraper, browser } = makeScraper();
    await scraper.listBienesRaices();

    expect(browser.waitForAny).toHaveBeenCalledWith(
      expect.arrayContaining(['LISTADO DE BIENES RAÍCES']),
      expect.any(Number)
    );
  });
});
