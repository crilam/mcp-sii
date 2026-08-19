import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

// Advertencia compartida por las cuatro tools. Va en las descripciones —no sólo
// en un comentario— porque el destinatario es un modelo que puede tener las dos
// salidas a la vista: `sii_dte_*` y `sii_rcv_*` consultan registros DISTINTOS y
// dan cifras que no cuadran, y sin este párrafo la conclusión natural es que uno
// de los dos está mal.
export const ADVERTENCIA_RCV =
  'NO COMPARABLE CON sii_rcv_*: Consultas DTE y el Registro de Compras y Ventas responden preguntas ' +
  'distintas y sus cifras NO cuadran; ninguno de los dos está mal. En los emitidos coinciden al peso ' +
  'en los tipos que ambos comparten, pero Consultas DTE incluye además las GUÍAS DE DESPACHO ' +
  '(tipo 52), que no existen en el RCV porque no afectan el IVA, y clasifica las FACTURAS DE COMPRA ' +
  '(tipo 46) como EMITIDAS —sección S2—, mientras el RCV las pone del lado de las compras (las emite ' +
  'el comprador, así que las dos tienen razón). En los recibidos los números directamente difieren. ' +
  'Para totales tributarios y de IVA usá sii_rcv_*; esto es la vista de documentos del SII. ' +
  'No presentes una diferencia entre las dos fuentes como un error de ninguna.';

export const ADVERTENCIA_SECCION =
  'La clave de una fila del resumen es (tipoDocCodigo, seccion), NO el tipo solo: el mismo tipo puede ' +
  'aparecer dos veces con secciones distintas (por ejemplo el 61 en S1 y en S2) y son filas diferentes. ' +
  'No las agrupes ni las sumes por tipo. S1 = afectos y exentos, S2 = facturas de compra y sus notas ' +
  'de crédito, S4 = exportación, S5 = guías de despacho.';

// El SII entrega estos datos POR PERÍODO MENSUAL. No hay consulta por rango de
// fechas, y no se emula una: fingir un rango recorriendo meses haría pasar por
// una capacidad del servicio algo que son N consultas, y con un límite de
// sesiones y sin control de tasa propio eso se paga caro. Se dice explícitamente
// para que nadie espere fecha_desde/fecha_hasta.
export const ADVERTENCIA_PERIODO =
  'La consulta es POR PERÍODO MENSUAL (periodo, AAAAMM): el SII entrega estos datos por mes y NO existe ' +
  'consulta por rango de fechas. Para varios meses hay que llamar una vez por mes. Si el usuario pide un ' +
  'rango, decile en qué meses se traduce antes de hacer varias llamadas.';

export const ADVERTENCIA_DETALLE =
  'El detalle CUESTA: incluir_detalle=true dispara una consulta al SII por cada fila del resumen. ' +
  'Empezá sin detalle para ver qué tipos hay en el período y después pedí el detalle acotado con ' +
  'tipo_doc. Para saber qué significa una lista `documentos` vacía mirá `estadoDetalle`: ' +
  '"no_pedido" = no se pidió el detalle, los documentos pueden existir y no se trajeron; "incluido" = se ' +
  'trajo, así que la lista vacía significa que NO hay documentos; "sin_filas_que_pedir" = se pidió, pero ' +
  'el período no tenía ninguna fila en ese alcance. Son tres situaciones distintas que se ven igual si ' +
  'sólo se mira la lista.';

// De dónde salen los montos es la pregunta que hay que responder ANTES de citar
// una cifra: hay dos clases de monto en esta aplicación y sólo una es auditable.
export const ADVERTENCIA_TOTALES =
  'DE DÓNDE SALEN LOS MONTOS: mirá `origenDeMontos` antes de citar cualquier cifra. ' +
  'Con "suma_de_documentos" (sólo cuando incluir_detalle=true) el campo `totales` está calculado sumando ' +
  'los documentos que coinciden con lo pedido —todos, no sólo los que devuelve limit— y ES auditable. ' +
  'Con "declarados_por_el_sii" (el camino por defecto, sin detalle) `totales` viene en null y los únicos ' +
  'montos son filas[].montoNetoDeclarado / montoIvaDeclarado / montoTotalDeclarado: son DECLARADOS por el ' +
  'SII y NO cuadran con la suma de los documentos (verificado: 163.060.976 sumando 393 documentos contra ' +
  '197.733.705 declarados). Podés citarlos, pero SIEMPRE diciendo que son los montos que declara el SII y ' +
  'que no se pueden reconciliar documento por documento; para una cifra auditable hay que pedir el ' +
  'detalle. Y `totales: null` NO significa cero pesos: significa que no se sumó nada porque no se pidió ' +
  'el detalle. Si totalesDifierenDelDeclarado es true, eso es lo normal, no una falla.';

export const ADVERTENCIA_VACIO =
  'CÓMO LEER UN RESULTADO VACÍO, sin adivinar: `sinDatos=true` significa que el alcance consultado ' +
  '(período + tipo_doc + seccion) no tiene documentos, y se mide igual con detalle y sin él. ' +
  '`filtroContraparteSinCoincidencias=true` es OTRA cosa: el período SÍ tiene documentos, pero ninguno es ' +
  'de la contraparte pedida —típicamente el RUT está mal— y NO hay que reportarlo como un mes sin ' +
  'movimientos. `alcance` repite qué se pidió, incluido si el detalle se pidió y qué filtros quedaron ' +
  'aplicados: usalo para no atribuir al período entero una cifra que es de un tipo o de una contraparte.';

export const ADVERTENCIA_CONTRAPARTE =
  'La contraparte de cada documento viene en `contraparte*` con un `contraparteRol` explícito: en los ' +
  'EMITIDOS el rol es "receptor" (el cliente) y en los RECIBIDOS es "emisor" (el proveedor que nos ' +
  'emitió el documento). Usá contraparteRol y no el nombre de ningún otro campo para decidir quién es ' +
  'quién.';

export const EMPRESA_RUT_DESC =
  'RUT de la empresa a consultar, con dígito verificador (22222222-2). La empresa es un parámetro de ' +
  'cada consulta, no de la sesión: no hay que seleccionarla antes y se puede cambiar en cada llamada. ' +
  'Si se omite, se consulta el RUT autenticado.';

export const PERIODO_DESC = 'Período tributario en formato AAAAMM (por ejemplo 202607)';

// Las dos tools de listado toman exactamente los mismos parámetros: sólo
// cambia la operación, que va en el nombre de la tool y no en el esquema.
export function schemaListado() {
  return {
    rut: z.string().describe(RUT_DESC),
    periodo: z.string().regex(/^\d{6}$/).describe(PERIODO_DESC),
    empresa_rut: z.string().optional().describe(EMPRESA_RUT_DESC),
    tipo_doc: z.number().int().positive().optional()
      .describe('Acota a un tipo de documento (33 factura electrónica, 34 exenta, 61 nota de crédito, ' +
        '46 factura de compra, 52 guía de despacho, 110 exportación). Si se omite, trae todos los ' +
        'tipos del período, con una consulta de detalle por fila del resumen.'),
    seccion: z.string().optional()
      .describe('Acota a una sección (S1, S2, S4, S5). Sirve para separar las dos filas de un mismo ' +
        'tipo de documento.'),
    contraparte_rut: z.string().optional()
      .describe('Filtra los documentos por RUT de la contraparte (22222222-2): el cliente en los ' +
        'emitidos, el proveedor en los recibidos. Es un filtro del lado del servidor MCP, sobre el ' +
        'detalle ya traído: NO reduce las consultas al SII. EXIGE incluir_detalle=true; con ' +
        'incluir_detalle=false la llamada FALLA en vez de devolver el resumen sin filtrar. Si no ' +
        'coincide ningún documento, la respuesta trae filtroContraparteSinCoincidencias=true, que no ' +
        'es lo mismo que un período sin movimientos.'),
    limit: z.number().int().min(1).max(500).optional()
      .describe('Máximo de documentos a devolver. Recorta la lista después de traerla, así que NO ' +
        'reduce las consultas al SII; sirve para no volcar cientos de documentos. EXIGE ' +
        'incluir_detalle=true: sin detalle la llamada FALLA en vez de ignorar el límite. Cuando ' +
        'recorta, documentosTruncados queda en true y totalDocumentos dice cuántos hay en realidad ' +
        '(los totales se calculan sobre todos, no sobre los devueltos).'),
    incluir_detalle: z.boolean().default(false)
      .describe('false por defecto: devuelve SÓLO el resumen por (tipo, sección) con UNA consulta. ' +
        'true trae además cada documento, y eso cuesta una consulta al SII POR CADA fila del resumen ' +
        '(siete en un período típico si no se acota con tipo_doc). El uso normal es resumen primero, ' +
        'y después el detalle del tipo que interese con tipo_doc: pedí incluir_detalle=true sólo ' +
        'cuando de verdad hagan falta los documentos.'),
  };
}

export const schemaDocumento = {
  rut: z.string().describe(RUT_DESC),
  periodo: z.string().regex(/^\d{6}$/).describe(PERIODO_DESC),
  tipo_doc: z.number().int().positive()
    .describe('Código del tipo de documento (33 factura electrónica, 34 exenta, 61 nota de crédito, ' +
      '46 factura de compra, 52 guía de despacho, 110 exportación)'),
  folio: z.number().int().positive().describe('Número de folio del documento'),
  empresa_rut: z.string().optional().describe(EMPRESA_RUT_DESC),
};
