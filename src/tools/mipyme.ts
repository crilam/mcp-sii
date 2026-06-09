import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MipymeScraper } from '../scrapers/mipyme';

const EmpresaRutSchema = z.string().optional().describe('RUT empresa. Usa SII_EMPRESA_RUT si se omite.');
const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Formato YYYY-MM-DD');

export function registerMipymeTools(server: McpServer, scraper: MipymeScraper): void {
  server.tool(
    'sii_mipyme_list_empresas',
    'Lista todas las empresas que la persona autenticada puede operar en el Sistema de Facturación Gratuito del SII (mipyme.sii.cl). Usar antes de otras tools cuando SII_EMPRESA_RUT no está configurado.',
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

  server.tool(
    'sii_mipyme_list_dte_emitidos',
    'Lista el historial de DTE emitidos en el Sistema de Facturación Gratuito del SII (mipyme.sii.cl). Devuelve folio, tipo, receptor, monto y estado de cada documento.',
    {
      empresa_rut: EmpresaRutSchema,
      tipo_dte: z.number().int().optional().describe('Filtrar por tipo: 33=factura, 34=exenta, 61=N.crédito, 56=N.débito, 52=guía, 46=F.compra'),
      fecha_desde: FechaSchema,
      fecha_hasta: FechaSchema,
      receptor_rut: z.string().optional().describe('Filtrar por RUT del receptor'),
      folio: z.number().int().optional().describe('Filtrar por folio exacto'),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async ({ empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, folio, limit }) => {
      const docs = await scraper.listMipymeDteEmitidos({
        empresaRut: empresa_rut,
        tipoDte: tipo_dte,
        fechaDesde: fecha_desde,
        fechaHasta: fecha_hasta,
        receptorRut: receptor_rut,
        folio,
        limit,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(docs, null, 2) }],
      };
    }
  );

  server.tool(
    'sii_mipyme_emitir_dte',
    'Emite un DTE (factura, nota de crédito, guía de despacho, etc.) en el Sistema de Facturación Gratuito del SII (mipyme.sii.cl). Requiere RUT y DV del receptor separados. Devuelve el folio asignado.',
    {
      empresa_rut: EmpresaRutSchema,
      tipo_dte: z.number().int().describe('Tipo DTE: 33=factura, 34=exenta, 61=N.crédito, 56=N.débito, 52=guía, 46=F.compra'),
      receptor_rut: z.string().describe('RUT del receptor sin DV (ej: "33333333")'),
      receptor_dv: z.string().describe('DV del receptor (ej: "1" o "K")'),
      lineas: z.array(z.object({
        descripcion: z.string().describe('Descripción del ítem'),
        cantidad: z.number().describe('Cantidad'),
        precio_unitario: z.number().int().describe('Precio unitario sin IVA'),
      })).min(1).describe('Líneas de detalle del documento'),
    },
    async ({ empresa_rut, tipo_dte, receptor_rut, receptor_dv, lineas }) => {
      const result = await scraper.emitirDte({
        empresaRut: empresa_rut,
        tipoDte: tipo_dte,
        receptorRut: receptor_rut,
        receptorDv: receptor_dv,
        lineas: lineas.map(l => ({
          descripcion: l.descripcion,
          cantidad: l.cantidad,
          precioUnitario: l.precio_unitario,
        })),
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
