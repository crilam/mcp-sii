import { datosContribuyente } from '../../src/core/misii';
import { EjecutorSesion } from '../../src/registroSesiones';
import { SessionManager } from '../../src/session';
import * as scraperMod from '../../src/scrapers/misii';

jest.mock('../../src/scrapers/misii', () => {
  const real = jest.requireActual('../../src/scrapers/misii');
  return { ...real, MisiiScraper: jest.fn() };
});

const MisiiScraper = scraperMod.MisiiScraper as unknown as jest.Mock;

// Ejecutor de mentira: corre la función con una sesión cualquiera. El core no
// mira la sesión, la usa para construir el scraper, que acá está mockeado.
const ejecutor: EjecutorSesion<SessionManager> = {
  ejecutar: (_rut, fn) => fn({} as SessionManager),
};

function fichaDe(rut: string) {
  return { rut, razonSocial: 'EMPRESA DE PRUEBA S.A.', actividades: [], atributos: [], regimen: null };
}

describe('datosContribuyente', () => {
  afterEach(() => jest.clearAllMocks());

  // La ficha es de la IDENTIDAD AUTENTICADA. Si por lo que sea el portal
  // devolviera la de otro contribuyente —una sesión cruzada en el registro, un
  // cambio del portal—, el consumidor la persistiría contra el RUT que pidió y
  // escribiría la identidad de otro sin ninguna señal. Es el peor error posible
  // de este endpoint, así que se corta acá y no se confía en que no pase.
  it('falla si el RUT de la ficha no es el que se pidió', async () => {
    MisiiScraper.mockImplementation(() => ({ datosContribuyente: async () => fichaDe('99999999-9') }));

    await expect(datosContribuyente(ejecutor, '11111111-1')).rejects.toThrow(/99999999-9/);
  });

  it('acepta el RUT pedido aunque venga con puntos', async () => {
    MisiiScraper.mockImplementation(() => ({ datosContribuyente: async () => fichaDe('11111111-1') }));

    await expect(datosContribuyente(ejecutor, '11.111.111-1'))
      .resolves.toMatchObject({ rut: '11111111-1' });
  });

  it('compara el dígito verificador, no sólo el cuerpo', async () => {
    MisiiScraper.mockImplementation(() => ({ datosContribuyente: async () => fichaDe('11111111-5') }));

    await expect(datosContribuyente(ejecutor, '11111111-1')).rejects.toThrow();
  });

  // `capturadoEn` es cuándo se leyó DEL SII, no cuándo se respondió. Hoy son
  // casi lo mismo; en cuanto haya caché dejan de serlo, y fechar con la hora de
  // la respuesta afirmaría una confirmación contra el SII que no ocurrió — que
  // es justo la fecha que el consumidor le muestra al usuario en su ficha.
  it('sella la fecha de captura', async () => {
    MisiiScraper.mockImplementation(() => ({ datosContribuyente: async () => fichaDe('11111111-1') }));

    const antes = new Date().toISOString();
    const ficha = await datosContribuyente(ejecutor, '11111111-1');

    expect(ficha.capturadoEn >= antes).toBe(true);
    expect(ficha.capturadoEn <= new Date().toISOString()).toBe(true);
  });
});
