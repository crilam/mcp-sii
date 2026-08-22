import { resumen, listEmitidas, listRecibidas, pdf } from '../../src/core/bhe';
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

  // Tres posicionales seguidos (rut, código, flag): invertir los dos últimos
  // compila igual y devolvería el PDF de otra cosa sin que nada avise.
  it('pdf pasa el código de barras y el flag de recibida, en ese orden', async () => {
    const contenido = Buffer.from('%PDF-1.3');
    (MockScraper.prototype.pdfBoleta as jest.Mock).mockResolvedValue(contenido);

    const resultado = await pdf(registroQueEjecuta(), '11.111.111-1', '111111110000048F99ED', true);

    expect(MockScraper.prototype.pdfBoleta).toHaveBeenCalledWith('111111110000048F99ED', true);
    expect(resultado).toBe(contenido);
  });

  it('pdf pide la emitida cuando no se pasa el flag', async () => {
    (MockScraper.prototype.pdfBoleta as jest.Mock).mockResolvedValue(Buffer.from('x'));

    await pdf(registroQueEjecuta(), '11.111.111-1', '111111110000048F99ED');

    expect(MockScraper.prototype.pdfBoleta).toHaveBeenCalledWith('111111110000048F99ED', false);
  });
});
