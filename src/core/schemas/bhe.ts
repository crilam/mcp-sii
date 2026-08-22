import { z } from 'zod';

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
  // `.trim()` antes del `.min(1)`: sin él, `"   "` pasa la validación y muere
  // más adentro como el ERROR genérico del contrato en vez de un 400 claro.
  //
  // Y sólo alfanuméricos: todos los códigos observados lo son
  // ("17270613000007FEB33E", "033333333034364C969E7"). Restringirlo evita
  // mandarle basura al SII, y sobre todo evita que un valor con separadores
  // ("../../x") se propague al `nombre_archivo` que devuelve la ruta y termine
  // siendo un path traversal en el consumidor que guarde el PDF con ese nombre.
  codigo_barras: z.string().trim().regex(
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
