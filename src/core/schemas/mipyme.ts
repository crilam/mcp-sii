import { z } from 'zod';
import { EmitirDteParams } from '../../scrapers/mipymeHttp';
import { rutEsValido } from '../../rut';

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

// El respaldo XML pide las fechas OBLIGATORIAS, al revés que los listados: sin
// rango, el portal devuelve todo el histórico y choca contra su propio tope de
// 20 documentos por descarga en la primera llamada. Pedirlas explícitamente
// evita una consulta al SII que se sabe de antemano que va a fallar.
// No alcanza con el formato: `2026-02-31` y `2026-13-01` lo cumplen y NO son
// fechas. Importa porque el troceo del respaldo hace aritmética con ellas —
// `Date.parse` de una fecha imposible da NaN y `toISOString()` sobre NaN lanza
// un RangeError sin nada que le diga al caller qué mandó mal. El round-trip a
// ISO es lo que descarta el 31 de febrero: el Date normaliza al 3 de marzo y
// deja de coincidir con lo pedido.
const FechaRequerida = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va en formato YYYY-MM-DD')
  // El `refine` corre AUNQUE el regex haya fallado —zod acumula los errores en
  // vez de cortar—, así que acá puede llegar cualquier string. Sin el guard por
  // NaN, `toISOString` lanza el mismo RangeError que este chequeo viene a
  // evitar, sólo que ahora desde la validación.
  .refine(f => {
    const d = new Date(`${f}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
  }, 'La fecha tiene que existir en el calendario (ojo con el 31 de un mes de 30)');

export const schemaRespaldoXml = {
  rut: z.string().min(1).describe(RUT_DESC),
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa con dígito verificador. Si se omite, se resuelve solo si este RUT opera una única empresa en el portal.'),
  origen: z.enum(['recibidos', 'emitidos']).default('recibidos')
    .describe('Lado del respaldo: recibidos (default) o emitidos'),
  fecha_desde: FechaRequerida.describe('Inicio del rango, YYYY-MM-DD'),
  fecha_hasta: FechaRequerida.describe('Fin del rango, YYYY-MM-DD'),
  tipo_dte: z.number().int().optional()
    .describe('Filtrar por tipo: 33=factura, 34=exenta, 61=N.crédito, 56=N.débito, 52=guía, 46=F.compra'),
  // Los filtros valen más que la comodidad: cada uno recorta el conjunto, y con
  // el tope de 20 documentos por descarga eso significa menos tramos, menos
  // llamadas al portal y menos latencia. Filtrar por contraparte puede convertir
  // tres tramos en uno.
  //
  // La CONTRAPARTE y no "el emisor": en esta pantalla el portal usa un solo
  // campo para los dos lados, así que con origen=recibidos filtra por emisor y
  // con emitidos por receptor. Un nombre que fije uno de los dos mentiría en el
  // otro caso, que es peor que pedir una línea de documentación.
  // El formato se valida acá y no sólo se normaliza en el scraper: un RUT
  // basura no da error en el portal, da CERO resultados — y un respaldo vacío se
  // lee exactamente igual que "este período no tuvo documentos". Mejor 400.
  // Cuando viene CON dígito verificador se valida el DV de verdad, no sólo la
  // forma: un `77777777-3` bien formado pero con DV incorrecto produce el mismo
  // cero-resultados silencioso que este chequeo viene a evitar. Sin DV no hay
  // nada que validar más allá de la forma — y se acepta, porque es lo que el
  // portal quiere igual.
  contraparte_rut: z.string()
    .transform(v => v.replace(/\./g, '').trim())
    .refine(v => /^\d{5,9}(-[\dkK])?$/.test(v),
      'contraparte_rut tiene que ser un RUT (con o sin dígito verificador), por ejemplo 77777777-7')
    .refine(v => !v.includes('-') || rutEsValido(v.split('-')[0], v.split('-')[1]),
      'El dígito verificador de contraparte_rut no corresponde al RUT')
    .optional()
    .describe('RUT de la contraparte: el EMISOR si origen=recibidos, el RECEPTOR si origen=emitidos. Con o sin dígito verificador.'),
  // `.trim()` y `.min(1)`: un string vacío o de puros espacios viajaría tal cual
  // a `RZN_SOC` y el portal no matchearía nada — el mismo respaldo vacío
  // indistinguible de "no hubo documentos" que motiva validar la contraparte.
  // El `.max()` no es burocracia: este valor viaja en la QUERY del GET de
  // descarga, y una cadena larga infla la URL sin que el portal la use — su
  // propio campo tiene 100 de maxlength.
  razon_social: z.string().trim()
    .min(1, 'razon_social no puede ser vacía')
    .max(100, 'razon_social no puede superar los 100 caracteres')
    .optional()
    .describe('Filtrar por razón social de la contraparte (el portal hace match parcial)'),
  folio_desde: z.number().int().positive().optional()
    .describe('Folio inicial del rango. Sin folio_hasta, filtra ese folio exacto.'),
  folio_hasta: z.number().int().positive().optional()
    .describe('Folio final del rango. Requiere folio_desde.'),
  // El tope existe para que un rango ancho no se convierta en un barrido: el
  // SII entrega 20 documentos por descarga, así que cada tramo extra es otra
  // llamada al portal dentro de la misma request.
  // Default 10 y no 24: cada tramo es una descarga con su pausa de ritmo, y la
  // request retiene el lock de la empresa mientras dura. Con 24 el techo de
  // latencia pasa de los dos minutos y todo lo demás sobre ese RUT responde
  // SERVICIO_OCUPADO mientras tanto. Diez cubre un mes normal de sobra; quien
  // necesite más lo pide explícitamente y sabe lo que eso cuesta.
  max_tramos: z.number().int().min(1).max(48).default(10)
    .describe('Máximo de descargas al SII para cubrir el rango (default 10). Cada tramo agrega ~2s de latencia y retiene el lock de la empresa.'),
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

// Los campos del DOCUMENTO, sin `confirmar` ni nada específico de emitir o de
// guardar-borrador. Los dos schemas se COMPONEN desde acá, en vez de que el
// borrador derive del de emisión quitándole `confirmar`: así un campo que mañana
// sea exclusivo de emisión (por ejemplo algo de firma) NO se filtra al borrador.
export const camposDocumento = {
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
};

// Emitir = los campos del documento + confirmar (firma y emite).
export const schemaEmitirDte = {
  ...camposDocumento,
  confirmar: z.boolean().default(false).describe('false (default) = sólo previsualiza. true = FIRMA Y EMITE el documento, acto real e irreversible.'),
};

// Guardar borrador = los mismos campos del documento + borrador_id + su propio
// confirmar. Un borrador NO se firma —es reversible—, así que no exige
// certificado: acepta clave o certificado como el resto.
export const schemaGuardarBorrador = {
  ...camposDocumento,
  borrador_id: z.string().optional()
    .describe('EHDR_CODIGO de un borrador existente a EDITAR. Si se omite, se crea uno nuevo.'),
  confirmar: z.boolean().default(false)
    .describe('false (default) = SIMULA: valida el documento y devuelve el resumen sin guardar. true = GUARDA el borrador (reversible: se puede editar o descartar; NO emite ni firma nada).'),
};

// Campos de un documento tal como llegan del body REST/MCP (snake_case). Lo
// comparten emitir-dte y guardar-borrador: es el mismo documento.
export interface CamposDocumentoBody {
  empresa_rut?: string; tipo_dte: number;
  receptor_rut: string; receptor_dv: string; receptor_razon_social: string; receptor_giro: string;
  receptor_direccion: string; receptor_comuna: string; receptor_ciudad: string;
  lineas: { descripcion: string; cantidad: number; precio_unitario: number; unidad?: string }[];
  forma_pago?: 1 | 2 | 3; ciudad_emisor?: string; fecha_emision?: string;
  referencias?: { tipo_doc: number; folio: number; fecha: string; razon?: string; codigo?: 1 | 2 | 3 }[];
}

/** Traduce los campos del body (snake_case) a EmitirDteParams. Único lugar. */
export function paramsDocumento(datos: CamposDocumentoBody): EmitirDteParams {
  return {
    empresaRut: datos.empresa_rut, tipoDte: datos.tipo_dte,
    receptor: {
      rut: datos.receptor_rut, dv: datos.receptor_dv, razonSocial: datos.receptor_razon_social,
      giro: datos.receptor_giro, direccion: datos.receptor_direccion, comuna: datos.receptor_comuna,
      ciudad: datos.receptor_ciudad,
    },
    lineas: datos.lineas.map(l => ({ nombre: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precio_unitario, unidad: l.unidad })),
    formaPago: datos.forma_pago, ciudadEmisor: datos.ciudad_emisor, fechaEmision: datos.fecha_emision,
    referencias: datos.referencias?.map(r => ({ tipoDoc: r.tipo_doc, folio: r.folio, fecha: r.fecha, razon: r.razon, codigo: r.codigo })),
  };
}
