import { fichaContribuyente } from '../../src/core/misii';
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

function fichaDe(rut: string, dv: string) {
  return {
    contribuyente: { rut, dv, razonSocial: 'EMPRESA DE EJEMPLO S.A.' },
    direcciones: [], atributos: [], actividades: [], alertas: [],
  };
}

describe('verificación de identidad de la ficha', () => {
  afterEach(() => jest.clearAllMocks());

  // La ficha es de la IDENTIDAD AUTENTICADA. Si por lo que sea el portal
  // devolviera la de otro contribuyente —una sesión cruzada en el registro, un
  // cambio del portal—, el consumidor la persistiría contra el RUT que pidió y
  // escribiría la identidad de otro sin ninguna señal. Es el peor error posible
  // de este endpoint, así que se corta acá y no se confía en que no pase.
  it('falla si el RUT de la ficha no es el que se pidió', async () => {
    MisiiScraper.mockImplementation(() => ({ ficha: async () => fichaDe('99999999', '9') }));

    await expect(fichaContribuyente(ejecutor, '22222222-2'))
      .rejects.toThrow(/22222222-2.*99999999-9|99999999-9.*22222222-2/);
  });

  it('acepta el RUT pedido aunque venga con puntos y sin normalizar', async () => {
    MisiiScraper.mockImplementation(() => ({ ficha: async () => fichaDe('22222222', '2') }));

    await expect(fichaContribuyente(ejecutor, '22.222.222-2'))
      .resolves.toMatchObject({ rut: '22222222-2' });
  });

  it('compara el dígito verificador, no sólo el cuerpo', async () => {
    MisiiScraper.mockImplementation(() => ({ ficha: async () => fichaDe('22222222', '5') }));

    await expect(fichaContribuyente(ejecutor, '22222222-2')).rejects.toThrow();
  });
});
