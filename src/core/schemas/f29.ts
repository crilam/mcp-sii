import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

// El período es AAAAMM. Desde 2007: la app declara que antes de enero de 2007 el
// F29 se consulta por otra vía.
const periodo = z.number().int()
  .refine(n => {
    const anio = Math.floor(n / 100), mes = n % 100;
    return anio >= 2007 && anio <= 2100 && mes >= 1 && mes <= 12;
  }, 'periodo debe ser AAAAMM, con año 2007-2100 y mes 01-12')
  .describe('Período tributario en formato AAAAMM (ej. 202507)');

// Estado y compacto piden lo mismo: RUT + período.
export const schemaEstadoF29 = {
  rut: z.string().min(1).describe(RUT_DESC),
  periodo,
};

export const schemaCompactoF29 = schemaEstadoF29;
