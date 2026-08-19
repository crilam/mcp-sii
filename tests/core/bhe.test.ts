import { resumen, listEmitidas, listRecibidas } from '../../src/core/bhe';
import { BheScraper } from '../../src/scrapers/bhe';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/bhe');
const MockScraper = BheScraper as jest.MockedClass<typeof BheScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/bhe', () => {
  afterEach(() => jest.clearAllMocks());

  it('resumen llama informeAnual con el año', async () => {
    (MockScraper.prototype.informeAnual as jest.Mock).mockResolvedValue({ meses: [] });
    const resultado = await resumen(registroQueEjecuta(), '11.111.111-1', 2026);
    expect(MockScraper.prototype.informeAnual).toHaveBeenCalledWith(2026);
    expect(resultado).toEqual({ meses: [] });
  });

  it('listEmitidas llama informeMensual sin el flag de recibidas', async () => {
    (MockScraper.prototype.informeMensual as jest.Mock).mockResolvedValue([]);
    await listEmitidas(registroQueEjecuta(), '11.111.111-1', 2026, 7);
    expect(MockScraper.prototype.informeMensual).toHaveBeenCalledWith(2026, 7, false);
  });

  it('listRecibidas llama informeMensual con recibidas=true', async () => {
    (MockScraper.prototype.informeMensual as jest.Mock).mockResolvedValue([]);
    await listRecibidas(registroQueEjecuta(), '11.111.111-1', 2026, 7);
    expect(MockScraper.prototype.informeMensual).toHaveBeenCalledWith(2026, 7, true);
  });
});
