import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MipymeScraper } from '../scrapers/mipyme';
import { MipymeHttpScraper } from '../scrapers/mipymeHttp';
import { getConfig } from '../env';

const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Formato YYYY-MM-DD');

// La consulta por HTTP necesita el RUT de la empresa: el portal mipyme no tiene
// una "empresa por defecto" que se pueda inferir sin consultar. Se resuelve acá
// —parámetro de la llamada, si no SII_EMPRESA_RUT— para no cambiar el contrato
// que tenían estas tools, y si no hay ninguno se falla nombrando la tool que
// lista las empresas en vez de dejar que el CGI responda un error genérico.
function resolverEmpresa(empresaRut?: string): string {
  const rut = empresaRut ?? getConfig().empresaRut;
  if (!rut) {
    throw new Error(
      'Falta el RUT de la empresa: pasá empresa_rut en la llamada o configura SII_EMPRESA_RUT. ' +
      'Usá sii_mipyme_list_empresas para ver las disponibles.'
    );
  }
  return rut;
}

export function registerMipymeTools(
  server: McpServer,
  http: MipymeHttpScraper,
  navegador: MipymeScraper
): void {
  server.tool(
    'sii_mipyme_list_empresas',
    'Lista las empresas que la persona autenticada puede operar en el Sistema de Facturación ' +
    'Gratuito del SII (mipyme.sii.cl). Usar antes de otras tools cuando SII_EMPRESA_RUT no está ' +
    'configurado. OJO: esta lista es la del portal mipyme y NO coincide con la de otras ' +
    'aplicaciones del SII — el Registro de Compras y Ventas y Consultas DTE habilitan su propio ' +
    'conjunto de empresas, que puede ser más amplio.',
    {},
    async () => {
      const empresas = await http.listEmpresas();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(empresas, null, 2) }],
      };
    }
  );

  server.tool(
    'sii_mipyme_list_dte_emitidos',
    'Lista el historial de DTE emitidos en el Sistema de Facturación Gratuito del SII ' +
    '(mipyme.sii.cl): folio, tipo, receptor, monto y estado de cada documento. Sin filtros de ' +
    'fecha devuelve el historial completo de la empresa, no el período actual. Entrega de a 100 ' +
    'documentos por página: usá "pagina" para las siguientes. Cubre sólo lo emitido POR ESTE ' +
    'portal, así que puede no coincidir con sii_dte_list_documentos_emitidos ni con sii_rcv_*, ' +
    'que consultan otros registros del SII.',
    {
      empresa_rut: z.string().optional().describe('RUT de la empresa con dígito verificador. Si se omite, usa SII_EMPRESA_RUT.'),
      tipo_dte: z.number().int().optional().describe('Filtrar por tipo: 33=factura, 34=exenta, 61=N.crédito, 56=N.débito, 52=guía, 46=F.compra'),
      fecha_desde: FechaSchema,
      fecha_hasta: FechaSchema,
      receptor_rut: z.string().optional().describe('Filtrar por RUT del receptor'),
      folio: z.number().int().optional().describe('Filtrar por folio exacto'),
      pagina: z.number().int().min(1).default(1).describe('Página del historial (100 documentos por página)'),
    },
    async ({ empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, folio, pagina }) => {
      const resultado = await http.listDteEmitidos({
        empresaRut: resolverEmpresa(empresa_rut),
        tipoDte: tipo_dte,
        fechaDesde: fecha_desde,
        fechaHasta: fecha_hasta,
        receptorRut: receptor_rut,
        folio,
        pagina,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(resultado, null, 2) }],
      };
    }
  );

  server.tool(
    'sii_mipyme_emitir_dte',
    'Emite un DTE (factura, nota de crédito, guía de despacho, etc.) en el Sistema de ' +
    'Facturación Gratuito del SII (mipyme.sii.cl). ADVERTENCIA: emitir es un acto tributario ' +
    'real e irreversible que notifica al receptor. ADEMÁS, hoy esta tool está probablemente ' +
    'inoperativa: el CGI al que apunta (mipeDocAlta.cgi) responde 404, medido el 2026-08-03. ' +
    'Requiere RUT y DV del receptor separados. Devuelve el folio asignado.',
    {
      empresa_rut: z.string().optional().describe('RUT empresa. Si se omite, usa SII_EMPRESA_RUT, o se resuelve solo si la persona opera una única empresa.'),
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
      const result = await navegador.emitirDte({
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
