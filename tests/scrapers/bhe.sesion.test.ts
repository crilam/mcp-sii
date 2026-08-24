import { BheScraper } from '../../src/scrapers/bhe';
import { SiiHttpClient } from '../../src/http';
import { RequiereCertificado, SessionManager } from '../../src/session';
import { Browser } from '../../src/browser';
import { AuthStrategy } from '../../src/env';

jest.mock('../../src/browser');

const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

// A diferencia de bhe.test.ts, acá el SessionManager es REAL: lo que se está
// probando es la interacción entre el scraper y la sesión, y con la sesión
// mockeada esa interacción no existe. Los tests que llamaban `rutaCookieJar()`
// directo no detectaron este camino justamente por eso.

// El jar del contexto, simulado: `borrarCookies` quita de verdad lo que se le
// pide y el submit repone la sesión. Es necesario porque loginConClave VERIFICA
// el borrado y aborta si sobrevive una cookie de sesión: un mock que devuelva
// siempre lo mismo haría fallar todo login.
function conJarSimulado(browser: Browser, presentes: string[]): void {
  // El login exige que se hayan escrito cookies: con 0 lanza a propósito, para
  // no dejar un jar vacío que después se reporte como sesión caducada.
  (browser.escribirCookieJar as jest.Mock).mockReturnValue(presentes.length);
  const ubicar = (nombres: string[]) =>
    nombres.map(name => ({ name, domain: '.sii.cl', path: '/', tieneValor: true }));
  let jar = ubicar(presentes);
  (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => jar);
  (browser.borrarCookies as jest.Mock).mockImplementation((aBorrar: Array<{ name: string }>) => {
    const nombres = new Set(aBorrar.map(c => c.name));
    jar = jar.filter(c => !nombres.has(c.name));
  });
  const evalPrevio = (browser.eval as jest.Mock).getMockImplementation();
  (browser.eval as jest.Mock).mockImplementation((js: string) => {
    if (js.includes('requestSubmit')) jar = ubicar(presentes);
    return evalPrevio ? evalPrevio(js) : '';
  });
}

function armar() {
  const browser = new MockBrowser();
  const session = new SessionManager(
    { rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'secreta' },
    browser
  );
  // Con estrategia de clave, assertPuedeEntregarCookieJar rechaza ANTES de
  // tocar el navegador (ver test más abajo), así que loginConClave nunca
  // llega a ejecutarse en estos casos. Se mockea igual, por si algún test
  // futuro fuerza el camino (ver "no reintenta aunque el fallo aparezca
  // recién dentro del intento").
  (browser.eval as jest.Mock).mockImplementation((js: string) =>
    js.includes("getElementById('myform')") ? 'SI' : ''
  );
  (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
  // El login se da por exitoso cuando el contexto tiene las cookies de sesión
  // del SII. Sin este mock, el poll de assertLoginPorClaveExitoso agota sus 15
  // segundos con tiempo real y el test muere por timeout.
  conJarSimulado(browser, ['TOKEN', 'CSESSIONID']);
  const autenticaciones = jest.spyOn(session, 'authenticateOnly');
  const http = {
    get: jest.fn(),
    postForm: jest.fn(),
  } as unknown as jest.Mocked<SiiHttpClient>;

  return {
    browser,
    autenticaciones,
    http,
    scraper: new BheScraper(http, session),
  };
}

// La clave tributaria SÍ habilita estas consultas: el login por clave exporta las
// cookies del navegador al jar que consume curl, y verificamos contra el portal
// que esos CGI responden con datos reales. Antes se rechazaban de entrada
// exigiendo certificado, que era una limitación nuestra y no del SII.
describe('BheScraper con estrategia de clave tributaria', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['informeAnual', (s: BheScraper) => s.informeAnual(2025)],
    ['informeMensual', (s: BheScraper) => s.informeMensual(2025, 3)],
    ['informeMensual recibidas', (s: BheScraper) => s.informeMensual(2025, 3, true)],
  ])('%s consulta el SII en vez de rechazar por falta de certificado', async (_nombre, invocar) => {
    const { scraper, autenticaciones, http } = armar();
    // Respuesta mínima con la cabecera que el parser exige.
    const informe = `<html><script>xml_values['anio_consulta'] = "2025";
      xml_values['total_boletas'] = "0";</script></html>`;
    (http.get as jest.Mock).mockResolvedValue(informe);
    (http.postForm as jest.Mock).mockResolvedValue(informe);

    await expect(invocar(scraper)).resolves.toBeDefined();

    // Autenticó UNA vez y consultó: ni rechazo previo ni reintento.
    expect(autenticaciones).toHaveBeenCalledTimes(1);
  });

  it('el login por clave deja escrito el cookie jar que usa curl', async () => {
    const { scraper, browser, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(
      `<html><script>xml_values['anio_consulta'] = "2025";</script></html>`
    );

    await scraper.informeAnual(2025);

    // Sin esto el navegador tiene la sesión y curl sale sin cookies: el fallo
    // aparecería después como "la sesión expiró", apuntando al lugar equivocado.
    expect(browser.escribirCookieJar).toHaveBeenCalled();
  });

  // Defensa en profundidad del segundo arreglo: aunque el chequeo previo ya
  // evita llegar acá, si algún camino futuro pide el cookie jar sin preguntar
  // antes, el error no debe reintentarse (serían dos sesiones en vez de una).
  it('no reintenta aunque el fallo aparezca recién dentro del intento', async () => {
    const { scraper, http, autenticaciones } = armar();
    const session = (scraper as unknown as { session: SessionManager }).session;
    // Se deja pasar el chequeo previo para simular que el fallo por falta de
    // certificado surge más adentro, ya con la sesión abierta. Se neutraliza en
    // todos los intentos, no sólo en el primero: si sólo se neutralizara el
    // primero, el reintento moriría en el chequeo previo y el test pasaría
    // aunque la marca de no reintentable no existiera.
    jest.spyOn(session, 'assertPuedeEntregarCookieJar')
      .mockImplementation(() => undefined);
    // El fallo se inyecta en el cliente HTTP, que es de donde llega en la
    // realidad: es `rutaCookieJar()` quien lo lanza, ya con la sesión abierta.
    (http.get as jest.Mock).mockRejectedValue(
      new RequiereCertificado('requiere certificado digital')
    );

    await expect(scraper.informeAnual(2025)).rejects.toThrow(/certificado digital/);

    // Exactamente una: sin la marca de no reintentable serían dos.
    expect(autenticaciones).toHaveBeenCalledTimes(1);
  });
});
