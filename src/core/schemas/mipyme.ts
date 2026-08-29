import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';
const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Formato YYYY-MM-DD');

export const schemaListEmpresas = {
  rut: z.string().min(1).describe(RUT_DESC),
};

export const schemaListDteEmitidos = {
  rut: z.string().min(1).describe(RUT_DESC),
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa con dígito verificador. Si se omite, se resuelve solo si este RUT opera una única empresa en el portal.'),
  tipo_dte: z.number().int().optional().describe('Filtrar por tipo: 33=factura, 34=exenta, 61=N.crédito, 56=N.débito, 52=guía, 46=F.compra'),
  fecha_desde: FechaSchema,
  fecha_hasta: FechaSchema,
  receptor_rut: z.string().optional().describe('Filtrar por RUT del receptor'),
  folio: z.number().int().optional().describe('Filtrar por folio exacto'),
  pagina: z.number().int().min(1).default(1).describe('Página del historial (100 documentos por página)'),
};

export const schemaListDteRecibidos = {
  rut: z.string().min(1).describe(RUT_DESC),
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa con dígito verificador. Si se omite, se resuelve solo si este RUT opera una única empresa en el portal.'),
  tipo_dte: z.number().int().optional().describe('Filtrar por tipo: 33=factura, 34=exenta, 61=N.crédito, 56=N.débito, 52=guía, 46=F.compra'),
  fecha_desde: FechaSchema,
  fecha_hasta: FechaSchema,
  // Del lado recibido la contraparte es el EMISOR: es el filtro simétrico a
  // `receptor_rut` de emitidos, y el portal lo llama `RUT_EMI`.
  emisor_rut: z.string().optional().describe('Filtrar por RUT del emisor'),
  folio: z.number().int().optional().describe('Filtrar por folio exacto'),
  pagina: z.number().int().min(1).default(1).describe('Página del historial (100 documentos por página)'),
};

export const schemaDtePdf = {
  rut: z.string().min(1).describe(RUT_DESC),
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa con dígito verificador. Si se omite, se resuelve solo si este RUT opera una única empresa en el portal.'),
  // El identificador es el `codigo` del listado y NO el folio: el folio se
  // repite entre emisores y entre tipos, así que no identifica un documento.
  // Se acepta como string aunque el SII lo entregue numérico: es un
  // identificador opaco, no se aritmetiza, y el string no rompe si el SII le
  // agrega letras.
  codigo: z.string().regex(/^\d+$/, 'codigo debe ser el del listado del portal (sólo dígitos)')
    .describe('Código del documento, tal como lo devuelve list-dte-emitidos o list-dte-recibidos'),
};

export const schemaListBorradores = {
  rut: z.string().min(1).describe(RUT_DESC),
  // Los borradores cuelgan de la empresa ACTIVA de la sesión del portal. Sin
  // este campo, un RUT que opera varias empresas recibe los borradores de la
  // que haya dejado la consulta anterior — y un listado de otra empresa se lee
  // perfectamente bien, así que nadie se entera.
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa con dígito verificador. Si se omite, se resuelve solo si este RUT opera una única empresa en el portal.'),
};

export const schemaEmitirDte = {
  rut: z.string().min(1).describe(RUT_DESC),
  empresa_rut: z.string().optional()
    .describe('RUT empresa. Si se omite, se resuelve solo si la persona opera una única empresa.'),
  tipo_dte: z.number().int().describe('33=factura, 34=factura exenta, 61=nota de crédito'),
  receptor_rut: z.string().describe('RUT del receptor sin DV (ej: "33333333")'),
  receptor_dv: z.string().describe('DV del receptor (ej: "1" o "K")'),
  receptor_razon_social: z.string().describe('Razón social del receptor'),
  receptor_giro: z.string().describe('Giro del receptor'),
  receptor_direccion: z.string().describe('Dirección del receptor'),
  receptor_comuna: z.string().describe('Comuna del receptor'),
  receptor_ciudad: z.string().describe('Ciudad del receptor'),
  lineas: z.array(z.object({
    descripcion: z.string().max(25).describe('Descripción del ítem (máximo 25 caracteres: es el límite del portal)'),
    cantidad: z.number().describe('Cantidad'),
    precio_unitario: z.number().int().describe('Precio unitario sin IVA'),
    unidad: z.string().optional().describe('Unidad de medida (máximo 4 caracteres)'),
  })).min(1).describe('Líneas de detalle del documento'),
  forma_pago: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('1=contado, 2=crédito (default), 3=sin costo'),
  ciudad_emisor: z.string().optional().describe('Ciudad del emisor. El portal la exige y no la trae cargada; si se omite se usa su comuna.'),
  fecha_emision: FechaSchema.describe('Fecha de emisión YYYY-MM-DD. Si se omite, la del día que trae el portal.'),
  referencias: z.array(z.object({
    tipo_doc: z.number().int().describe('Tipo del documento referenciado: 33, 34, 39, 61, 56, 801...'),
    folio: z.number().int().describe('Folio del documento referenciado'),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha del documento referenciado, YYYY-MM-DD'),
    razon: z.string().max(90).optional().describe('Razón de la referencia'),
    codigo: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('1=anula, 2=corrige texto, 3=corrige montos. Obligatorio en nota de crédito.'),
  })).max(3).optional().describe('Hasta 3 referencias. Una nota de crédito exige al menos una.'),
  confirmar: z.boolean().default(false).describe('false (default) = sólo previsualiza. true = FIRMA Y EMITE el documento, acto real e irreversible.'),
};
