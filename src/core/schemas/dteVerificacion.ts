import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

// Los tipos que ofrece el propio formulario del SII.
const TIPOS_DTE = [33, 34, 46, 52, 56, 61, 43, 110, 111, 112] as const;

const baseDte = {
  rut: z.string().min(1).describe(RUT_DESC),
  rut_emisor: z.string().min(3).describe('RUT del emisor del documento, con dígito verificador (ej. "77777777-7")'),
  tipo_dte: z.number().int().refine(t => (TIPOS_DTE as readonly number[]).includes(t), 'tipo_dte no es uno de los que el SII permite verificar')
    .describe('33 factura, 34 exenta, 46 factura de compra, 52 guía, 56 nota de débito, 61 nota de crédito, 43 liquidación, 110/111/112 exportación'),
  folio: z.number().int().positive().describe('Folio del documento'),
};

export const schemaValidezDte = baseDte;

export const schemaContenidoDte = {
  ...baseDte,
  rut_receptor: z.string().min(3).describe('RUT del receptor, con dígito verificador'),
  fecha_emision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').describe('Fecha de emisión, YYYY-MM-DD'),
  monto_total: z.number().int().nonnegative().describe('Monto total del documento, en pesos'),
};
