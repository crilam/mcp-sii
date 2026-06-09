import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDocumentosTools } from '../../src/tools/documentos';
import { MipymeScraper } from '../../src/scrapers/mipyme';

jest.mock('../../src/scrapers/mipyme');
const MockScraper = MipymeScraper as jest.MockedClass<typeof MipymeScraper>;

describe('registerDocumentosTools', () => {
  it('registra las 4 tools de documentos', () => {
    const scraper = new MockScraper({} as any, {} as any);
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerDocumentosTools(server, scraper);
    const tools = (server as any)._registeredTools;
    expect(tools['sii_list_documentos_emitidos']).toBeDefined();
    expect(tools['sii_get_documento_emitido']).toBeDefined();
    expect(tools['sii_list_documentos_recibidos']).toBeDefined();
    expect(tools['sii_get_documento_recibido']).toBeDefined();
  });

  it('sii_list_documentos_emitidos llama al scraper con filtros', async () => {
    const scraper = new MockScraper({} as any, {} as any);
    (scraper.listDocumentosEmitidos as jest.Mock).mockResolvedValue([]);
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerDocumentosTools(server, scraper);
    const tool = (server as any)._registeredTools['sii_list_documentos_emitidos'];
    await tool.handler({ fecha_desde: '2026-01-01', fecha_hasta: '2026-01-31' });
    expect(scraper.listDocumentosEmitidos).toHaveBeenCalledWith(
      expect.objectContaining({ fechaDesde: '2026-01-01', fechaHasta: '2026-01-31' })
    );
  });
});
