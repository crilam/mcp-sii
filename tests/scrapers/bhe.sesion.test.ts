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
  (browser.cookiesDelSii as jest.Mock).mockReturnValue(['TOKEN', 'CSESSIONID']);
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

// Cada autenticación abre una sesión en el SII y el servicio bloquea el RUT que
// acumule varias (01.01.190.500.720.27). Con estrategia de clave estas consultas
// no pueden funcionar nunca, así que el costo correcto es cero sesiones: ni la
// del primer intento ni la del reintento. Verificar sólo que lanza dejaba pasar
// exactamente el bug que esto cubre.
describe('BheScraper con estrategia de clave tributaria', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['informeAnual', (s: BheScraper) => s.informeAnual(2025)],
    ['informeMensual', (s: BheScraper) => s.informeMensual(2025, 3)],
    ['informeMensual recibidas', (s: BheScraper) => s.informeMensual(2025, 3, true)],
  ])('%s no abre ninguna sesión en el SII y no reintenta', async (_nombre, invocar) => {
    const { scraper, browser, autenticaciones, http } = armar();

    await expect(invocar(scraper)).rejects.toThrow(/certificado digital/);

    expect(autenticaciones).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
    expect(http.postForm).not.toHaveBeenCalled();
  });

  it('el mensaje sigue diciendo qué configurar', async () => {
    const { scraper } = armar();

    await expect(scraper.informeAnual(2025)).rejects.toThrow(/SII_CERT_PATH/);
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
