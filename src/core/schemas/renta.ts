import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export const anioSchema = z.number().int().min(2000).max(2100)
  .describe('Año tributario a consultar (el año en que se declaró, no el año de los ingresos)');

export const schemaEstadoDeclaracion = {
  rut: z.string().min(1).describe(RUT_DESC),
  anio: anioSchema,
};

export const schemaF22 = {
  rut: z.string().min(1).describe(RUT_DESC),
  anio: anioSchema,
  folio: z.number().int().positive().optional()
    .describe('Folio de la declaración. Si se omite, se usa el de la declaración vigente del año.'),
};
