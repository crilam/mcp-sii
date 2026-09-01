import { z } from 'zod';
import { CODIGO_BARRAS_VALIDO } from '../../scrapers/bheEmail';

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
//
// A diferencia de los otros schemas de este archivo, éste lo consume SÓLO el
// adaptador REST: no hay tool MCP del PDF, y la ausencia es deliberada. La tool
// tendría que devolver el PDF en base64 dentro del contexto del modelo, que es
// ruido y no información. Si alguna vez se expone en MCP, lo útil sería que la
// tool guarde el archivo y devuelva la ruta.
export const schemaPdf = {
  rut: z.string().min(1).describe(RUT_DESC),
  // `.trim()` primero: sin él, `"   "` llegaría al scraper y moriría como el
  // ERROR genérico del contrato en vez de un 400 que dice qué está mal. Quien
  // rechaza la cadena vacía es el `+` de la regex de abajo, no un `.min(1)`.
  //
  // Y sólo alfanuméricos: todos los códigos observados lo son
  // ("17270613000007FEB33E", "033333333034364C969E7"). Restringirlo evita
  // mandarle basura al SII, y sobre todo evita que un valor con separadores
  // ("../../x") se propague al `nombre_archivo` que devuelve la ruta y termine
  // siendo un path traversal en el consumidor que guarde el PDF con ese nombre.
  // `.max(40)`: los códigos observados tienen 20-21 caracteres. Sin cota, un
  // millón de alfanuméricos pasa la validación, arma una query enorme contra el
  // SII y gasta cupo del tenant para nada.
  codigo_barras: z.string().trim().max(40).regex(
    /^[A-Za-z0-9]+$/,
    'codigo_barras inválido: el SII usa sólo letras y dígitos'
  ).describe(
    'Código de barras de la boleta, tal como lo devuelve el campo codigoBarras ' +
    'del listado del mes. El folio no sirve para pedir el PDF.'
  ),
  recibida: z.boolean().default(false).describe(
    'true para una boleta recibida; false (default) para una emitida'
  ),
};

// --- Emisión (ronda 11, ESCRITURA) -----------------------------------------
export const schemaEmitirBhe = {
  rut: z.string().min(1).describe(RUT_DESC),
  receptor_rut: z.string().min(3).describe('RUT del receptor con dígito verificador (66666666-6).'),
  receptor_nombre: z.string().min(1).describe('Nombre o razón social del receptor.'),
  receptor_direccion: z.string().optional().describe('Dirección del receptor, si el portal la exige.'),
  receptor_comuna: z.string().optional().describe('Comuna del receptor, si el portal la exige.'),
  lineas: z.array(z.object({
    descripcion: z.string().min(1).describe('Descripción de la prestación.'),
    valor: z.number().int().positive().describe('Valor en pesos (entero, bruto).'),
  })).min(1).max(4).describe('Hasta 4 líneas de prestación (límite del portal).'),
  retiene_receptor: z.boolean().default(true)
    .describe('true (default): la retención la efectúa el RECEPTOR (empresa). false: la retiene el emisor.'),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Fecha de la boleta AAAA-MM-DD. Si se omite, la del día según el portal.'),
  confirmar: z.boolean().default(false)
    .describe('false (default): PREVISUALIZA con los montos que calcula el SII, sin emitir. true: EMITE la boleta — acto tributario REAL e IRREVERSIBLE que notifica al receptor.'),
};

// --- Anulación (ronda 11, ESCRITURA) -----------------------------------------
export const schemaAnularBhe = {
  rut: z.string().min(1).describe(RUT_DESC),
  folio: z.number().int().positive().describe('Folio (número) de la boleta emitida a anular.'),
  causa: z.union([z.literal(1), z.literal(2), z.literal(3)])
    .describe('Causa de la anulación según el portal: 1 = no se efectuó el pago de los servicios, '
      + '2 = no se efectuó la prestación de servicios, 3 = error en la digitación.'),
  confirmar: z.boolean().default(false)
    .describe('false (default): PREVISUALIZA la anulación (muestra la boleta que se anularía) sin anular. '
      + 'true: ANULA la boleta — acto tributario REAL e IRREVERSIBLE.'),
};

// --- Observación (ronda 11, ESCRITURA del RECEPTOR) --------------------------
export const schemaObservarBhe = {
  rut: z.string().min(1).describe(RUT_DESC),
  anio: z.number().int().min(2000).describe('Año del período en que la boleta figura como recibida.'),
  mes: z.number().int().min(1).max(12).describe('Mes del período (1-12).'),
  folio: z.number().int().positive().describe('Folio de la boleta RECIBIDA a observar.'),
  emisor_rut: z.string().min(3).optional()
    .describe('RUT del emisor de la boleta (con o sin DV). Obligatorio cuando el mismo folio se repite entre emisores en el período: el folio es por emisor.'),
  causa: z.union([z.literal(1), z.literal(2)])
    .describe('Causa según el portal: 1 = no se efectuó el pago de los servicios, 2 = no se efectuó la prestación de servicios.'),
  confirmar: z.boolean().default(false)
    .describe('false (default): PREVISUALIZA sin observar. true: OBSERVA la boleta — acto REAL e IRREVERSIBLE (el comentario no se puede borrar).'),
};

// --- Reenvío por email (ronda 11, ESCRITURA leve) -----------------------------
export const schemaEmailBhe = {
  rut: z.string().min(1).describe(RUT_DESC),
  codigo_barras: z.string().regex(CODIGO_BARRAS_VALIDO)
    .describe('Código de barras de la boleta emitida (el mismo que usa el PDF), NO el folio.'),
  email: z.string().email().optional()
    .describe('Email de destino. Si se omite, el que el portal tiene registrado para el receptor.'),
  confirmar: z.boolean().default(false)
    .describe('false (default): PREVISUALIZA (muestra a qué email se enviaría) sin enviar. true: ENVÍA el correo con la boleta.'),
};

