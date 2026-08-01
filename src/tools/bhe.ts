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

  const paramsMes = {
    anio: z.number().int().min(2000).max(2100).describe('Año a consultar'),
    mes: z.number().int().min(1).max(12).describe('Mes a consultar (1-12)'),
  };

  server.tool(
    'sii_bhe_list_emitidas',
    'Lista boleta por boleta las boletas de honorarios electrónicas emitidas por el RUT persona autenticado en un mes: folio, fecha, receptor, honorario bruto, retención del emisor y del receptor, total líquido y si está anulada. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    paramsMes,
    async ({ anio, mes }: { anio: number; mes: number }) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify(await scraper.informeMensual(anio, mes), null, 2),
      }],
    })
  );

  server.tool(
    'sii_bhe_list_recibidas',
    'Lista las boletas de honorarios electrónicas recibidas por el RUT persona autenticado en un mes, con el mismo detalle que las emitidas. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    paramsMes,
    async ({ anio, mes }: { anio: number; mes: number }) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify(await scraper.informeMensual(anio, mes, true), null, 2),
      }],
    })
  );
}
