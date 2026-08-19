import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export const schemaResumen = {
  rut: z.string().describe(RUT_DESC),
  anio: z.number().int().min(2000).max(2100).describe('Año tributario a consultar'),
};

export const schemaMes = {
  rut: z.string().describe(RUT_DESC),
  anio: z.number().int().min(2000).max(2100).describe('Año a consultar'),
  mes: z.number().int().min(1).max(12).describe('Mes a consultar (1-12)'),
};
