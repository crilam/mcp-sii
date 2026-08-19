import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

const camposComunes = {
  periodo: z.string().regex(/^\d{6}$/)
    .describe('Período tributario en formato AAAAMM (por ejemplo 202607)'),
  operacion: z.enum(['COMPRA', 'VENTA'])
    .describe('COMPRA para el registro de compras, VENTA para el de ventas'),
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa a consultar, con dígito verificador (22222222-2). Si se omite, se usa el RUT autenticado.'),
};

export const schemaResumen = {
  rut: z.string().min(1).describe(RUT_DESC),
  ...camposComunes,
};

export const schemaDetalle = {
  rut: z.string().min(1).describe(RUT_DESC),
  ...camposComunes,
  tipo_doc: z.number().int().positive()
    .describe('Código del tipo de documento, obligatorio. Se obtiene de sii_rcv_resumen en filas[].tipoDocCodigo (33 factura electrónica, 61 nota de crédito, 46 factura de compra, 34 exenta, 110 exportación, 914 DIN, 56 nota de débito)'),
};
