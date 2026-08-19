import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export const schemaListBienesRaices = {
  rut: z.string().min(1).describe(RUT_DESC),
};
