import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BienesRaicesScraper } from '../scrapers/bienesRaices';

export function registerBienesRaicesTools(server: McpServer, scraper: BienesRaicesScraper): void {
  server.tool(
    'sii_persona_list_bienes_raices',
    'Lista los bienes raíces (propiedades) del RUT persona autenticado en el SII, con comuna, ROL, dirección, destino, datos de inscripción, porcentaje de derechos y avalúo fiscal. Incluye un resumen con total de propiedades, solicitudes, notificaciones, afectación a sobretasa y beneficio de adulto mayor. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    {},
    async () => {
      const result = await scraper.listBienesRaices();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
