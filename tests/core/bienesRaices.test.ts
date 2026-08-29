import { listBienesRaices, comunas, consultarPorRol } from '../../src/core/bienesRaices';
import { BienesRaicesHttpScraper } from '../../src/scrapers/bienesRaicesHttp';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/bienesRaicesHttp');
const MockScraper = BienesRaicesHttpScraper as jest.MockedClass<typeof BienesRaicesHttpScraper>;

// El core ya no pide el navegador a la sesión: bienes raíces va por HTTP. Si un
// refactor volviera a `obtenerBrowser`, cada consulta levantaría Chromium otra
// vez y dependería de la cola virtual del portal.
function registroFalso() {
  const sesion = { obtenerBrowser: jest.fn(() => { throw new Error('no debería abrir navegador'); }) };
  return {
    registro: { ejecutar: (_rut: string, fn: any) => fn(sesion) } as unknown as RegistroSesiones<any>,
    sesion,
  };
}

describe('core/bienesRaices', () => {
  afterEach(() => jest.clearAllMocks());

  it('arma el scraper HTTP con la sesión y no toca el navegador', async () => {
    (MockScraper.prototype.listBienesRaices as jest.Mock).mockResolvedValue({ propiedades: [] });
    const { registro, sesion } = registroFalso();

    const resultado = await listBienesRaices(registro, '11.111.111-1');

    expect(resultado).toEqual({ propiedades: [] });
    expect(MockScraper).toHaveBeenCalledWith(expect.anything(), sesion);
    expect(sesion.obtenerBrowser).not.toHaveBeenCalled();
  });

  it('comunas delega al scraper', async () => {
    (MockScraper.prototype.comunas as jest.Mock).mockResolvedValue([{ codigo: 1, nombre: 'X', regional: 1 }]);
    const { registro } = registroFalso();

    await expect(comunas(registro, '11.111.111-1')).resolves.toHaveLength(1);
  });

  it('consultarPorRol pasa el rol tal cual', async () => {
    (MockScraper.prototype.consultarPorRol as jest.Mock).mockResolvedValue([]);
    const { registro } = registroFalso();

    await consultarPorRol(registro, '11.111.111-1', { comuna: 8201, manzana: 632, predio: 244 });

    expect(MockScraper.prototype.consultarPorRol)
      .toHaveBeenCalledWith({ comuna: 8201, manzana: 632, predio: 244 });
  });
});
