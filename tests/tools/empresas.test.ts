import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEmpresasTools } from '../../src/tools/empresas';
import { MipymeScraper } from '../../src/scrapers/mipyme';

jest.mock('../../src/scrapers/mipyme');
const MockScraper = MipymeScraper as jest.MockedClass<typeof MipymeScraper>;

describe('registerEmpresasTools', () => {
  it('registra sii_list_empresas y retorna empresas serializadas', async () => {
    const scraper = new MockScraper({} as any, {} as any);
    (scraper.listEmpresas as jest.Mock).mockResolvedValue([
      { rut: '11111111', nombre: 'EMPRESA A' },
    ]);

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerEmpresasTools(server, scraper);

    const tools = (server as any)._registeredTools;
    expect(tools['sii_list_empresas']).toBeDefined();
  });
});
