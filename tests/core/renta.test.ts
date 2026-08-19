import { estadoDeclaracion, f22Completo } from '../../src/core/renta';
import { RentaScraper } from '../../src/scrapers/renta';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/renta');
const MockScraper = RentaScraper as jest.MockedClass<typeof RentaScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/renta', () => {
  afterEach(() => jest.clearAllMocks());

  it('estadoDeclaracion pasa el año', async () => {
    (MockScraper.prototype.estadoDeclaracion as jest.Mock).mockResolvedValue({ declaraciones: [] });
    const resultado = await estadoDeclaracion(registroQueEjecuta(), '11.111.111-1', 2026);
    expect(MockScraper.prototype.estadoDeclaracion).toHaveBeenCalledWith(2026);
    expect(resultado).toEqual({ declaraciones: [] });
  });

  it('f22Completo pasa año y folio (opcional)', async () => {
    (MockScraper.prototype.f22Completo as jest.Mock).mockResolvedValue({ lineas: [] });
    await f22Completo(registroQueEjecuta(), '11.111.111-1', 2026, 123);
    expect(MockScraper.prototype.f22Completo).toHaveBeenCalledWith(2026, 123);
  });

  it('f22Completo sin folio pasa undefined', async () => {
    (MockScraper.prototype.f22Completo as jest.Mock).mockResolvedValue({ lineas: [] });
    await f22Completo(registroQueEjecuta(), '11.111.111-1', 2026, undefined);
    expect(MockScraper.prototype.f22Completo).toHaveBeenCalledWith(2026, undefined);
  });
});
