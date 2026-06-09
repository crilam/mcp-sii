import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MipymeScraper } from '../scrapers/mipyme';

const TipoDteSchema = z.number().int().optional().describe('Tipo DTE: 33=factura, 34=factura exenta, 39=boleta, 61=nota de crédito');
const EmpresaRutSchema = z.string().optional().describe('RUT empresa a consultar. Usa SII_EMPRESA_RUT si se omite.');
const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Formato YYYY-MM-DD');

export function registerDocumentosTools(server: McpServer, scraper: MipymeScraper): void {
  server.tool(
    'sii_list_documentos_emitidos',
    'Lista DTEs emitidos por la empresa en el SII. Requiere certificado digital.',
    {
      empresa_rut: EmpresaRutSchema,
      tipo_dte: TipoDteSchema,
      fecha_desde: FechaSchema,
      fecha_hasta: FechaSchema,
      receptor_rut: z.string().optional().describe('Filtrar por RUT del receptor'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async ({ empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, limit }) => {
      const docs = await scraper.listDocumentosEmitidos({
        empresaRut: empresa_rut,
        tipoDte: tipo_dte,
        fechaDesde: fecha_desde,
        fechaHasta: fecha_hasta,
        receptorRut: receptor_rut,
        limit,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(docs, null, 2) }],
      };
    }
  );

  server.tool(
    'sii_get_documento_emitido',
    'Detalle completo de un DTE emitido específico incluyendo líneas de detalle. Requiere certificado digital.',
    {
      tipo_dte: z.number().int().describe('Tipo DTE: 33=factura, 34=factura exenta, 39=boleta, 61=nota de crédito'),
      folio: z.number().int().describe('Número de folio del documento'),
      empresa_rut: EmpresaRutSchema,
    },
    async ({ tipo_dte, folio, empresa_rut }) => {
      const doc = await scraper.getDocumentoEmitido(tipo_dte, folio, empresa_rut);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(doc, null, 2) }],
      };
    }
  );

  server.tool(
    'sii_list_documentos_recibidos',
    'Lista DTEs recibidos por la empresa en el SII. Requiere certificado digital.',
    {
      empresa_rut: EmpresaRutSchema,
      tipo_dte: TipoDteSchema,
      fecha_desde: FechaSchema,
      fecha_hasta: FechaSchema,
      emisor_rut: z.string().optional().describe('Filtrar por RUT del emisor'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async ({ empresa_rut, tipo_dte, fecha_desde, fecha_hasta, emisor_rut, limit }) => {
      const docs = await scraper.listDocumentosRecibidos({
        empresaRut: empresa_rut,
        tipoDte: tipo_dte,
        fechaDesde: fecha_desde,
        fechaHasta: fecha_hasta,
        emisorRut: emisor_rut,
        limit,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(docs, null, 2) }],
      };
    }
  );

  server.tool(
    'sii_get_documento_recibido',
    'Detalle completo de un DTE recibido específico incluyendo líneas de detalle. Requiere certificado digital.',
    {
      tipo_dte: z.number().int().describe('Tipo DTE del documento recibido'),
      folio: z.number().int().describe('Número de folio del documento'),
      emisor_rut: z.string().describe('RUT del emisor del documento'),
      empresa_rut: EmpresaRutSchema,
    },
    async ({ tipo_dte, folio, emisor_rut, empresa_rut }) => {
      const doc = await scraper.getDocumentoRecibido(tipo_dte, folio, emisor_rut, empresa_rut);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(doc, null, 2) }],
      };
    }
  );
}
