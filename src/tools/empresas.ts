import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MipymeScraper } from '../scrapers/mipyme';

export function registerEmpresasTools(server: McpServer, scraper: MipymeScraper): void {
  server.tool(
    'sii_list_empresas',
    'Lista todas las empresas que la persona autenticada puede operar en el SII. Usar antes de otras tools cuando SII_EMPRESA_RUT no está configurado.',
    {},
    async () => {
      const empresas = await scraper.listEmpresas();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(empresas, null, 2),
        }],
      };
    }
  );
}
