import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BheScraper } from '../scrapers/bhe';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { crearConScraper } from '../erroresSesion';

const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

const conScraper = crearConScraper(sesion => new BheScraper(new SiiHttpClient(sesion), sesion));

export function registerBheTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_bhe_resumen',
    'Resumen anual de las boletas de honorarios electrónicas emitidas por el RUT persona autenticado en el SII. Devuelve, por cada mes con actividad, el honorario bruto, la retención de terceros y del contribuyente, el rango de folios y cuántas boletas están vigentes o anuladas. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    {
      rut: z.string().describe(RUT_DESC),
      anio: z.number().int().min(2000).max(2100).describe('Año tributario a consultar'),
    },
    async ({ rut, anio }: { rut: string; anio: number }) =>
      conScraper(registro, rut, scraper => scraper.informeAnual(anio))
  );

  const paramsMes = {
    rut: z.string().describe(RUT_DESC),
    anio: z.number().int().min(2000).max(2100).describe('Año a consultar'),
    mes: z.number().int().min(1).max(12).describe('Mes a consultar (1-12)'),
  };

  server.tool(
    'sii_bhe_list_emitidas',
    'Lista boleta por boleta las boletas de honorarios electrónicas emitidas por el RUT persona autenticado en un mes: folio, fecha, receptor de la boleta (en contraparteRut/contraparteNombre, con contraparteRol="receptor"), honorario bruto, retención del emisor y del receptor, total líquido y si está anulada. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    paramsMes,
    async ({ rut, anio, mes }: { rut: string; anio: number; mes: number }) =>
      conScraper(registro, rut, scraper => scraper.informeMensual(anio, mes))
  );

  server.tool(
    'sii_bhe_list_recibidas',
    'Lista las boletas de honorarios electrónicas recibidas por el RUT persona autenticado en un mes: folio, fecha, emisor de la boleta (en contraparteRut/contraparteNombre, con contraparteRol="emisor"), honorario bruto, retención del receptor, total líquido y si está anulada. El SII no informa la retención del emisor en las recibidas, así que retencionEmisor viene en null. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    paramsMes,
    async ({ rut, anio, mes }: { rut: string; anio: number; mes: number }) =>
      conScraper(registro, rut, scraper => scraper.informeMensual(anio, mes, true))
  );
}
