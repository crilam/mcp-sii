import { listBienesRaices } from '../../src/core/bienesRaices';
import { BienesRaicesScraper } from '../../src/scrapers/bienesRaices';
import { RegistroSesiones } from '../../src/registroSesiones';
import { Browser } from '../../src/browser';

jest.mock('../../src/scrapers/bienesRaices');
const MockScraper = BienesRaicesScraper as jest.MockedClass<typeof BienesRaicesScraper>;

describe('core/bienesRaices', () => {
  afterEach(() => jest.clearAllMocks());

  it('arma el scraper con el Browser de la sesión y llama listBienesRaices', async () => {
    (MockScraper.prototype.listBienesRaices as jest.Mock).mockResolvedValue({ propiedades: [] });
    const browser = new Browser();
    const registro = {
      ejecutar: (_rut: string, fn: any) => fn({ obtenerBrowser: () => browser }),
    } as unknown as RegistroSesiones<any>;

    const resultado = await listBienesRaices(registro, '11.111.111-1');

    expect(resultado).toEqual({ propiedades: [] });
    expect(MockScraper).toHaveBeenCalledWith(browser, expect.anything());
  });
});
