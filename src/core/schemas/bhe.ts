import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export const schemaResumen = {
  rut: z.string().min(1).describe(RUT_DESC),
  anio: z.number().int().min(2000).max(2100).describe('Año tributario a consultar'),
};

export const schemaMes = {
  rut: z.string().min(1).describe(RUT_DESC),
  anio: z.number().int().min(2000).max(2100).describe('Año a consultar'),
  mes: z.number().int().min(1).max(12).describe('Mes a consultar (1-12)'),
};

// El PDF se pide por código de barras, no por folio: es lo único que el CGI
// acepta. Se toma tal cual del listado del mes, sin validar forma ni largo (es
// un identificador opaco del SII y los largos observados varían).
export const schemaPdf = {
  rut: z.string().min(1).describe(RUT_DESC),
  codigo_barras: z.string().min(1).describe(
    'Código de barras de la boleta, tal como lo devuelve el campo codigoBarras ' +
    'del listado del mes. El folio no sirve para pedir el PDF.'
  ),
  recibida: z.boolean().default(false).describe(
    'true para una boleta recibida; false (default) para una emitida'
  ),
};
