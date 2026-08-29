import { z } from 'zod';

// Sin `rut` ni credencial: la tabla de códigos es una página pública del SII.
export const schemaActividades = {
  categoria: z.string().min(1).max(2).optional()
    .describe('Categoría tributaria tal como la publica el SII: "1" (primera), "2" (segunda) u otro valor que traiga la tabla'),
  afecta_iva: z.boolean().optional().describe('Sólo actividades afectas (true) o no afectas (false) a IVA'),
  texto: z.string().min(2).max(80).optional().describe('Texto a buscar en la descripción, el subrubro o el rubro'),
};

export const schemaActividad = {
  codigo: z.string().regex(/^\d{6}$/, 'El código de actividad económica tiene seis dígitos')
    .describe('Código de actividad económica de seis dígitos (ej. "011101")'),
};

export const schemaVerificarRut = {
  rut: z.string().min(2).max(12).describe('RUT a verificar, con o sin puntos y guión (ej. "12.345.678-5")'),
};
