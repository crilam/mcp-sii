import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OperacionRcv, RcvScraper } from '../scrapers/rcv';

export function registerRcvTools(server: McpServer, scraper: RcvScraper): void {
  server.tool(
    'sii_rcv_resumen',
    'Resumen del Registro de Compras y Ventas de un período tributario: los totales por tipo de documento ' +
    '(cantidad de documentos, neto, exento, IVA y total), el total de documentos del período y la fecha de ' +
    'última actualización del registro. El campo `totales` viene con las notas de crédito (tipos 61 y 60) ' +
    'RESTADAS, que es como corresponde totalizar: sumarlas infla las ventas y el IVA. ' +
    'Si el período no tiene documentos registrados, responde sinDatos=true con los totales en cero: es un ' +
    'mes sin movimientos, no un error. ' +
    'La empresa es un parámetro de la consulta, no de la sesión: se puede pasar empresa_rut distinto en ' +
    'cada llamada, sin seleccionar empresa; si se omite, se consulta el RUT autenticado. ' +
    'Es solo lectura: no acepta ni reclama documentos.',
    {
      periodo: z.string().regex(/^\d{6}$/)
        .describe('Período tributario en formato AAAAMM (por ejemplo 202607)'),
      operacion: z.enum(['COMPRA', 'VENTA'])
        .describe('COMPRA para el registro de compras, VENTA para el de ventas'),
      empresa_rut: z.string().optional()
        .describe('RUT de la empresa a consultar, con dígito verificador (76543210-K). Si se omite, se usa el RUT autenticado.'),
    },
    async ({ periodo, operacion, empresa_rut }: {
      periodo: string;
      operacion: OperacionRcv;
      empresa_rut?: string;
    }) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify(await scraper.resumen(periodo, operacion, empresa_rut), null, 2),
      }],
    })
  );
}
