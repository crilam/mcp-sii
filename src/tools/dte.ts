import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MipymeScraper } from '../scrapers/mipyme';

const TipoDteSchema = z.number().int().optional().describe('Tipo DTE: 33=factura, 34=factura exenta, 39=boleta, 61=nota de crédito');
const EmpresaRutSchema = z.string().optional().describe('RUT empresa a consultar. Si se omite, usa SII_EMPRESA_RUT, o se resuelve solo si la persona opera una única empresa.');
const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Formato YYYY-MM-DD');

export function registerDteTools(server: McpServer, scraper: MipymeScraper): void {
  server.tool(
    'sii_dte_list_documentos_emitidos',
    'Lista DTEs emitidos por la empresa en Consultas DTE del SII. Requiere certificado digital.',
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
    'sii_dte_get_documento_emitido',
    'Detalle de un DTE emitido específico por tipo y folio en Consultas DTE. Si el documento no es del mes actual, indica fecha_doc en formato YYYY-MM-DD. Requiere certificado digital.',
    {
      tipo_dte: z.number().int().describe('Tipo DTE: 33=factura, 34=factura exenta, 39=boleta, 61=nota de crédito'),
      folio: z.number().int().describe('Número de folio del documento'),
      empresa_rut: EmpresaRutSchema,
      fecha_doc: FechaSchema.describe('Fecha aproximada del documento (YYYY-MM-DD) para buscar en el mes correcto. Por defecto busca en el mes actual.'),
    },
    async ({ tipo_dte, folio, empresa_rut, fecha_doc }) => {
      const doc = await scraper.getDocumentoEmitido(tipo_dte, folio, empresa_rut, fecha_doc);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(doc, null, 2) }],
      };
    }
  );

  server.tool(
    'sii_dte_list_documentos_recibidos',
    'Lista DTEs recibidos por la empresa en Consultas DTE del SII. Requiere certificado digital.',
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
    'sii_dte_get_documento_recibido',
    'Detalle de un DTE recibido específico por folio en Consultas DTE. Si el documento no es del mes actual, indica fecha_doc en formato YYYY-MM-DD. Requiere certificado digital.',
    {
      tipo_dte: z.number().int().describe('Tipo DTE del documento recibido'),
      folio: z.number().int().describe('Número de folio del documento'),
      emisor_rut: z.string().describe('RUT del emisor del documento'),
      empresa_rut: EmpresaRutSchema,
      fecha_doc: FechaSchema.describe('Fecha aproximada del documento (YYYY-MM-DD) para buscar en el mes correcto.'),
    },
    async ({ tipo_dte, folio, emisor_rut, empresa_rut, fecha_doc }) => {
      const doc = await scraper.getDocumentoRecibido(tipo_dte, folio, emisor_rut, empresa_rut, fecha_doc);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(doc, null, 2) }],
      };
    }
  );
}
