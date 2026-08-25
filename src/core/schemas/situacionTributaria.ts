import { z } from 'zod';

export const RUT_DESC =
  'RUT del contribuyente a consultar, con guion y dígito verificador (ej. "76632059-7"). ' +
  'Consulta pública de terceros: NO requiere clave ni sesión.';

export const schemaSituacionTributaria = {
  rut: z.string().min(1).describe(RUT_DESC),
};
