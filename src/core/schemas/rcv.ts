import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

// Extraído a constante para que un arreglo a la regla del formato (por
// ejemplo, si el SII alguna vez acepta otro rango de meses) se aplique en
// TODOS los esquemas que validan período y no sólo en el que se editó. Antes
// la misma expresión estaba duplicada entera en dos lugares; con eso, corregir
// una y olvidarse de la otra dejaba un esquema validando distinto sin que
// nadie lo notara hasta que fallara en producción.
const validadorPeriodo = z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/)
  .describe('Período tributario en formato AAAAMM (por ejemplo 202607). El mes debe ser 01-12.');

// El texto del tipo de documento se comparte entre los cinco esquemas que lo
// piden (detalle síncrono y las tres variantes async), por la misma razón que
// `validadorPeriodo`: es el texto MÁS completo —incluye de dónde se obtiene el
// código y el detalle de cada valor—, y antes las variantes async tenían una
// versión resumida que además decía "igual que en sii_rcv_detalle" cuando ya
// no lo era.
const DESC_TIPO_DOC = 'Código del tipo de documento, obligatorio. Se obtiene de sii_rcv_resumen en '
  + 'filas[].tipoDocCodigo (33 factura electrónica, 61 nota de crédito, 46 factura de compra, 34 exenta, '
  + '110 exportación, 914 DIN, 56 nota de débito)';

const camposComunes = {
  periodo: validadorPeriodo,
  operacion: z.enum(['COMPRA', 'VENTA'])
    .describe('COMPRA para el registro de compras, VENTA para el de ventas'),
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa a consultar, con dígito verificador (22222222-2). Si se omite, se usa el RUT autenticado.'),
};

export const schemaResumen = {
  rut: z.string().min(1).describe(RUT_DESC),
  ...camposComunes,
};

export const schemaDetalle = {
  rut: z.string().min(1).describe(RUT_DESC),
  ...camposComunes,
  tipo_doc: z.number().int().positive().describe(DESC_TIPO_DOC),
};

// Sólo el RUT: la lista de empresas autorizadas no depende de período ni de
// operación.
export const schemaEmpresasAutorizadas = {
  rut: z.string().min(1).describe('RUT de la persona autenticada, con dígito verificador.'),
};

// Sólo el RUT: el catálogo de tipos de documento no depende de empresa ni de
// período.
export const schemaTiposDocumento = {
  rut: z.string().min(1).describe('RUT de la persona autenticada, con dígito verificador.'),
};

// --- RCV asíncrono (cierre R1) --------------------------------------------
// Las tres consultas async piden lo mismo que el detalle síncrono: RUT +
// período + operación + tipo de documento. La llave natural de una solicitud es
// esa combinación, no un id opaco del SII, así que el consumidor no maneja ids.
export const schemaAsyncSolicitar = {
  rut: z.string().min(1).describe(RUT_DESC),
  ...camposComunes,
  tipo_doc: z.number().int().positive().describe(DESC_TIPO_DOC),
};

// estado y detalle piden exactamente lo mismo que solicitar.
//
// Se COPIAN a propósito, no se alias por identidad: que hoy las tres pidan lo
// mismo es un hecho de HOY, no un invariante. Con un alias, si mañana a
// `solicitar` le agregan un campo propio (por ejemplo, un parámetro que sólo
// tiene sentido al disparar la consulta, no al consultar su estado), `estado`
// y `detalle` lo heredarían en silencio sin que nadie lo decida. Copiando, el
// día que un contrato cambie hay que tocar los otros a mano, que es lo que
// corresponde para tres rutas que son distintas aunque hoy coincidan.
// `tests/core/schemas/rcv.test.ts` fija los campos de las tres contra una
// lista explícita, así que una edición que rompa la coincidencia de hoy no
// pasa en silencio.
export const schemaAsyncEstado = {
  rut: z.string().min(1).describe(RUT_DESC),
  ...camposComunes,
  tipo_doc: z.number().int().positive().describe(DESC_TIPO_DOC),
};
export const schemaAsyncDetalle = {
  rut: z.string().min(1).describe(RUT_DESC),
  ...camposComunes,
  tipo_doc: z.number().int().positive().describe(DESC_TIPO_DOC),
};
