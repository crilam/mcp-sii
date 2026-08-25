import { z } from 'zod';

export const RUT_DESC =
  'RUT del contribuyente a consultar, con guion y dígito verificador (ej. "22222222-2"). ' +
  'Consulta pública de terceros: NO requiere clave ni sesión.';

export const schemaSituacionTributaria = {
  rut: z.string().min(1).describe(RUT_DESC),
};
