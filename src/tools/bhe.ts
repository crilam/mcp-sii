import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BheScraper } from '../scrapers/bhe';

export function registerBheTools(server: McpServer, scraper: BheScraper): void {
  server.tool(
    'sii_bhe_resumen',
    'Resumen anual de las boletas de honorarios electrónicas emitidas por el RUT persona autenticado en el SII. Devuelve, por cada mes con actividad, el honorario bruto, la retención de terceros y del contribuyente, el rango de folios y cuántas boletas están vigentes o anuladas. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    { anio: z.number().int().min(2000).max(2100).describe('Año tributario a consultar') },
    async ({ anio }: { anio: number }) => {
      const informe = await scraper.informeAnual(anio);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(informe, null, 2) }],
      };
    }
  );
}
