import { registerBheTools } from '../../src/tools/bhe';
import { BheScraper } from '../../src/scrapers/bhe';

jest.mock('../../src/scrapers/bhe');

const MockScraper = BheScraper as jest.MockedClass<typeof BheScraper>;

function makeServer() {
  const tools: Record<string, { descripcion: string; handler: Function }> = {};
  const server = {
    tool: (nombre: string, descripcion: string, _schema: unknown, handler: Function) => {
      tools[nombre] = { descripcion, handler };
    },
  };
  return { server, tools };
}

describe('registerBheTools', () => {
  it('registra sii_bhe_resumen', () => {
    const { server, tools } = makeServer();

    registerBheTools(server as any, new MockScraper({} as any, {} as any));

    expect(Object.keys(tools)).toContain('sii_bhe_resumen');
  });

  // Las tools de persona natural no dependen de la empresa seleccionada, y la
  // descripción es lo único que ve el modelo para decidir cuándo usarlas.
  it('describe la tool como colgando de la persona, no de la empresa', () => {
    const { server, tools } = makeServer();

    registerBheTools(server as any, new MockScraper({} as any, {} as any));

    expect(tools['sii_bhe_resumen'].descripcion).toMatch(/SII_EMPRESA_RUT/);
  });

  it('devuelve el informe del año pedido como JSON', async () => {
    const { server, tools } = makeServer();
    const scraper = new MockScraper({} as any, {} as any);
    (scraper.informeAnual as jest.Mock).mockResolvedValue({
      anio: 2025,
      rut: '11111111-1',
      nombreContribuyente: 'JUAN PEREZ SOTO',
      meses: [],
      folioInicial: null,
      folioFinal: null,
    });

    registerBheTools(server as any, scraper);
    const result = await tools['sii_bhe_resumen'].handler({ anio: 2025 });

    expect(scraper.informeAnual).toHaveBeenCalledWith(2025);
    expect(JSON.parse(result.content[0].text).anio).toBe(2025);
  });

  it('registra sii_bhe_list_emitidas y sii_bhe_list_recibidas', () => {
    const { server, tools } = makeServer();

    registerBheTools(server as any, new MockScraper({} as any, {} as any));

    expect(Object.keys(tools)).toContain('sii_bhe_list_emitidas');
    expect(Object.keys(tools)).toContain('sii_bhe_list_recibidas');
  });

  it('sii_bhe_list_recibidas invoca al scraper con recibidas en true', async () => {
    const { server, tools } = makeServer();
    const scraper = new MockScraper({} as any, {} as any);
    (scraper.informeMensual as jest.Mock).mockResolvedValue([]);

    registerBheTools(server as any, scraper);
    await tools['sii_bhe_list_recibidas'].handler({ anio: 2025, mes: 5 });

    expect(scraper.informeMensual).toHaveBeenCalledWith(2025, 5, true);
  });
});
