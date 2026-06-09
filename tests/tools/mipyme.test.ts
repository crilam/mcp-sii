import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMipymeTools } from '../../src/tools/mipyme';
import { MipymeScraper } from '../../src/scrapers/mipyme';

jest.mock('../../src/scrapers/mipyme');
const MockScraper = MipymeScraper as jest.MockedClass<typeof MipymeScraper>;

describe('registerMipymeTools', () => {
  it('registra sii_mipyme_list_empresas y retorna empresas serializadas', async () => {
    const scraper = new MockScraper({} as any, {} as any);
    (scraper.listEmpresas as jest.Mock).mockResolvedValue([
      { rut: '11111111-1', nombre: 'EMPRESA A' },
    ]);

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerMipymeTools(server, scraper);

    const tools = (server as any)._registeredTools;
    expect(tools['sii_mipyme_list_empresas']).toBeDefined();
  });

  it('registra sii_mipyme_list_dte_emitidos y llama al scraper', async () => {
    const scraper = new MockScraper({} as any, {} as any);
    (scraper.listMipymeDteEmitidos as jest.Mock).mockResolvedValue([]);
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerMipymeTools(server, scraper);

    const tools = (server as any)._registeredTools;
    expect(tools['sii_mipyme_list_dte_emitidos']).toBeDefined();

    await tools['sii_mipyme_list_dte_emitidos'].handler({
      fecha_desde: '2026-01-01',
      fecha_hasta: '2026-01-31',
    });
    expect(scraper.listMipymeDteEmitidos).toHaveBeenCalledWith(
      expect.objectContaining({ fechaDesde: '2026-01-01', fechaHasta: '2026-01-31' })
    );
  });

  it('registra sii_mipyme_emitir_dte y llama al scraper con params', async () => {
    const scraper = new MockScraper({} as any, {} as any);
    (scraper.emitirDte as jest.Mock).mockResolvedValue({
      folio: 1234, tipoDte: 33, receptorRut: '33333333-3', total: 119000,
    });
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerMipymeTools(server, scraper);

    const tools = (server as any)._registeredTools;
    expect(tools['sii_mipyme_emitir_dte']).toBeDefined();

    const result = await tools['sii_mipyme_emitir_dte'].handler({
      tipo_dte: 33,
      receptor_rut: '33333333-3',
      receptor_dv: '1',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precio_unitario: 100000 }],
    });
    expect(scraper.emitirDte).toHaveBeenCalledWith(
      expect.objectContaining({
        tipoDte: 33,
        receptorRut: '33333333-3',
        receptorDv: '1',
        lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100000 }],
      })
    );
    expect(result.content[0].text).toContain('1234');
  });
});
