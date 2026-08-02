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
    'Si aparece un tipo de documento que el servidor no tiene catalogado, se suma a los totales pero la ' +
    'respuesta trae totalesConfiables=false, tiposDesconocidos y advertencias: en ese caso hay que avisar ' +
    'que los totales pueden estar mal antes de usarlos. ' +
    'Si el período no tiene documentos registrados, responde sinDatos=true con los totales en cero: es un ' +
    'mes sin movimientos, no un error (el campo mensaje explica el vacío cuando el SII lo explica, por ' +
    'ejemplo si el período es anterior al que cubre el registro). ' +
    'La empresa es un parámetro de la consulta, no de la sesión: se puede pasar empresa_rut distinto en ' +
    'cada llamada, sin seleccionar empresa; si se omite, se consulta el RUT autenticado. ' +
    'Es solo lectura: no acepta ni reclama documentos.',
    {
      periodo: z.string().regex(/^\d{6}$/)
        .describe('Período tributario en formato AAAAMM (por ejemplo 202607)'),
      operacion: z.enum(['COMPRA', 'VENTA'])
        .describe('COMPRA para el registro de compras, VENTA para el de ventas'),
      empresa_rut: z.string().optional()
        .describe('RUT de la empresa a consultar, con dígito verificador (22222222-2). Si se omite, se usa el RUT autenticado.'),
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

  server.tool(
    'sii_rcv_detalle',
    'Detalle documento por documento del Registro de Compras y Ventas de un período: para cada documento, ' +
    'la contraparte (RUT y razón social), el folio, la fecha de emisión, los montos neto/exento/IVA/total, ' +
    'el documento referenciado y el estado de aceptación o reclamo del receptor. ' +
    'REQUIERE el código de tipo de documento (tipo_doc): el SII entrega el detalle por tipo de documento, ' +
    'NO del período entero. Ese código sale de sii_rcv_resumen, en filas[].tipoDocCodigo, así que el orden ' +
    'es: primero sii_rcv_resumen para ver qué tipos hay en el período, después sii_rcv_detalle por cada ' +
    'tipo que interese (33 factura electrónica, 61 nota de crédito, 46 factura de compra, 34 exenta, ' +
    '110 exportación, 914 DIN, 56 nota de débito). ' +
    'La contraparte se informa con contraparteRol: en COMPRA es el emisor (el proveedor) y en VENTA es el ' +
    'receptor (el cliente); no hay que llamarla proveedor en una consulta de ventas. ' +
    'En notas de crédito y débito, referenciaTipoDoc y referenciaFolio dicen qué documento se está ' +
    'corrigiendo. ' +
    'Si el período o el tipo no tienen documentos registrados, responde sinDatos=true con documentos=[]: ' +
    'es un vacío legítimo, no un error (el campo mensaje explica el vacío cuando el SII lo explica). ' +
    'La empresa es un parámetro de la consulta, no de la sesión: se puede pasar empresa_rut distinto en ' +
    'cada llamada; si se omite, se consulta el RUT autenticado. ' +
    'Es solo lectura: no acepta ni reclama documentos.',
    {
      periodo: z.string().regex(/^\d{6}$/)
        .describe('Período tributario en formato AAAAMM (por ejemplo 202607)'),
      operacion: z.enum(['COMPRA', 'VENTA'])
        .describe('COMPRA para el registro de compras, VENTA para el de ventas'),
      tipo_doc: z.number().int().positive()
        .describe('Código del tipo de documento, obligatorio. Se obtiene de sii_rcv_resumen en filas[].tipoDocCodigo (33 factura electrónica, 61 nota de crédito, 46 factura de compra, 34 exenta, 110 exportación, 914 DIN, 56 nota de débito)'),
      empresa_rut: z.string().optional()
        .describe('RUT de la empresa a consultar, con dígito verificador (22222222-2). Si se omite, se usa el RUT autenticado.'),
    },
    async ({ periodo, operacion, tipo_doc, empresa_rut }: {
      periodo: string;
      operacion: OperacionRcv;
      tipo_doc: number;
      empresa_rut?: string;
    }) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify(
          await scraper.detalle(periodo, operacion, tipo_doc, empresa_rut),
          null,
          2
        ),
      }],
    })
  );
}
