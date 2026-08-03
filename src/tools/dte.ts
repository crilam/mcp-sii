import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DteScraper, OperacionDte } from '../scrapers/dte';

// Advertencia compartida por las cuatro tools. Va en las descripciones —no sólo
// en un comentario— porque el destinatario es un modelo que puede tener las dos
// salidas a la vista: `sii_dte_*` y `sii_rcv_*` consultan registros DISTINTOS y
// dan cifras que no cuadran, y sin este párrafo la conclusión natural es que uno
// de los dos está mal.
const ADVERTENCIA_RCV =
  'NO COMPARABLE CON sii_rcv_*: Consultas DTE y el Registro de Compras y Ventas responden preguntas ' +
  'distintas y sus cifras NO cuadran; ninguno de los dos está mal. En los emitidos coinciden al peso ' +
  'en los tipos que ambos comparten, pero Consultas DTE incluye además las GUÍAS DE DESPACHO ' +
  '(tipo 52), que no existen en el RCV porque no afectan el IVA, y clasifica las FACTURAS DE COMPRA ' +
  '(tipo 46) como EMITIDAS —sección S2—, mientras el RCV las pone del lado de las compras (las emite ' +
  'el comprador, así que las dos tienen razón). En los recibidos los números directamente difieren. ' +
  'Para totales tributarios y de IVA usá sii_rcv_*; esto es la vista de documentos del SII. ' +
  'No presentes una diferencia entre las dos fuentes como un error de ninguna.';

const ADVERTENCIA_SECCION =
  'La clave de una fila del resumen es (tipoDocCodigo, seccion), NO el tipo solo: el mismo tipo puede ' +
  'aparecer dos veces con secciones distintas (por ejemplo el 61 en S1 y en S2) y son filas diferentes. ' +
  'No las agrupes ni las sumes por tipo. S1 = afectos y exentos, S2 = facturas de compra y sus notas ' +
  'de crédito, S4 = exportación, S5 = guías de despacho.';

// El SII entrega estos datos POR PERÍODO MENSUAL. No hay consulta por rango de
// fechas, y no se emula una: fingir un rango recorriendo meses haría pasar por
// una capacidad del servicio algo que son N consultas, y con un límite de
// sesiones y sin control de tasa propio eso se paga caro. Se dice explícitamente
// para que nadie espere fecha_desde/fecha_hasta.
const ADVERTENCIA_PERIODO =
  'La consulta es POR PERÍODO MENSUAL (periodo, AAAAMM): el SII entrega estos datos por mes y NO existe ' +
  'consulta por rango de fechas. Para varios meses hay que llamar una vez por mes. Si el usuario pide un ' +
  'rango, decile en qué meses se traduce antes de hacer varias llamadas.';

const ADVERTENCIA_DETALLE =
  'El detalle CUESTA: incluir_detalle=true dispara una consulta al SII por cada fila del resumen. ' +
  'Empezá sin detalle para ver qué tipos hay en el período y después pedí el detalle acotado con ' +
  'tipo_doc.';

const ADVERTENCIA_TOTALES =
  'El campo `totales` es la SUMA DE LOS DOCUMENTOS QUE COINCIDEN con lo pedido (todos, no sólo los que ' +
  'devuelve limit). `totalesDeclarados` es lo que declara el ' +
  'SII y NO coincide con esa suma (verificado: 163.060.976 sumando 393 documentos contra 197.733.705 ' +
  'declarados). Usá `totales`; `totalesDeclarados` está sólo para explicar la cifra que muestra el ' +
  'portal. Si totalesDifierenDelDeclarado es true, eso es lo normal, no una falla.';

const ADVERTENCIA_CONTRAPARTE =
  'La contraparte de cada documento viene en `contraparte*` con un `contraparteRol` explícito: en los ' +
  'EMITIDOS el rol es "receptor" (el cliente) y en los RECIBIDOS es "emisor" (el proveedor que nos ' +
  'emitió el documento). Usá contraparteRol y no el nombre de ningún otro campo para decidir quién es ' +
  'quién.';

const EMPRESA_RUT_DESC =
  'RUT de la empresa a consultar, con dígito verificador (22222222-2). La empresa es un parámetro de ' +
  'cada consulta, no de la sesión: no hay que seleccionarla antes y se puede cambiar en cada llamada. ' +
  'Si se omite, se consulta el RUT autenticado.';

const PERIODO_DESC = 'Período tributario en formato AAAAMM (por ejemplo 202607)';

export function registerDteTools(server: McpServer, scraper: DteScraper): void {
  // Las dos tools de listado toman exactamente los mismos parámetros: sólo
  // cambia la operación, que va en el nombre de la tool y no en el esquema.
  const schemaListado = () => ({
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
        'detalle ya traído: NO reduce las consultas al SII. Requiere incluir_detalle=true.'),
    limit: z.number().int().min(1).max(500).optional()
      .describe('Máximo de documentos a devolver. Recorta la lista después de traerla, así que NO ' +
        'reduce las consultas al SII; sirve para no volcar cientos de documentos. Cuando recorta, ' +
        'documentosTruncados queda en true y totalDocumentos dice cuántos hay en realidad (los ' +
        'totales se calculan sobre todos, no sobre los devueltos).'),
    incluir_detalle: z.boolean().default(false)
      .describe('false por defecto: devuelve SÓLO el resumen por (tipo, sección) con UNA consulta. ' +
        'true trae además cada documento, y eso cuesta una consulta al SII POR CADA fila del resumen ' +
        '(siete en un período típico si no se acota con tipo_doc). El uso normal es resumen primero, ' +
        'y después el detalle del tipo que interese con tipo_doc: pedí incluir_detalle=true sólo ' +
        'cuando de verdad hagan falta los documentos.'),
  });

  const handler = (operacion: OperacionDte) =>
    async ({ periodo, empresa_rut, tipo_doc, seccion, contraparte_rut, limit, incluir_detalle }: {
      periodo: string;
      empresa_rut?: string;
      tipo_doc?: number;
      seccion?: string;
      contraparte_rut?: string;
      limit?: number;
      incluir_detalle: boolean;
    }) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify(
          await scraper.listar(periodo, operacion, {
            empresaRut: empresa_rut,
            tipoDocCodigo: tipo_doc,
            seccion,
            contraparteRut: contraparte_rut,
            limit,
            incluirDetalle: incluir_detalle,
          }),
          null,
          2
        ),
      }],
    });

  server.tool(
    'sii_dte_list_documentos_emitidos',
    'Documentos tributarios electrónicos EMITIDOS por la empresa en un período, según Consultas DTE del ' +
    'SII: por defecto el resumen por (tipo de documento, sección), y con incluir_detalle=true además ' +
    'cada documento con su contraparte, folio, fechas y montos. ' +
    ADVERTENCIA_PERIODO + ' ' + ADVERTENCIA_DETALLE + ' ' +
    ADVERTENCIA_SECCION + ' ' + ADVERTENCIA_CONTRAPARTE + ' ' + ADVERTENCIA_TOTALES + ' ' +
    'Un período sin documentos responde sinDatos=true con las listas vacías: es un mes sin movimientos, ' +
    'no un error. ' + ADVERTENCIA_RCV + ' Es solo lectura.',
    schemaListado(),
    handler('EMITIDOS')
  );

  server.tool(
    'sii_dte_list_documentos_recibidos',
    'Documentos tributarios electrónicos RECIBIDOS por la empresa en un período, según Consultas DTE del ' +
    'SII: por defecto el resumen por (tipo de documento, sección), y con incluir_detalle=true además ' +
    'cada documento con su contraparte, folio, fechas y montos. ' +
    ADVERTENCIA_PERIODO + ' ' + ADVERTENCIA_DETALLE + ' ' +
    'La contraparte de un documento recibido es el PROVEEDOR que lo emitió, y llega con ' +
    'contraparteRol="emisor" aunque el SII la informe en campos que se llaman "receptor". ' +
    ADVERTENCIA_SECCION + ' ' + ADVERTENCIA_CONTRAPARTE + ' ' + ADVERTENCIA_TOTALES + ' ' +
    'Un período sin documentos responde sinDatos=true con las listas vacías: es un mes sin movimientos, ' +
    'no un error. ' + ADVERTENCIA_RCV + ' Es solo lectura.',
    schemaListado(),
    handler('RECIBIDOS')
  );

  const schemaDocumento = {
    periodo: z.string().regex(/^\d{6}$/).describe(PERIODO_DESC),
    tipo_doc: z.number().int().positive()
      .describe('Código del tipo de documento (33 factura electrónica, 34 exenta, 61 nota de crédito, ' +
        '46 factura de compra, 52 guía de despacho, 110 exportación)'),
    folio: z.number().int().positive().describe('Número de folio del documento'),
    empresa_rut: z.string().optional().describe(EMPRESA_RUT_DESC),
  };

  const handlerDocumento = (operacion: OperacionDte) =>
    async ({ periodo, tipo_doc, folio, empresa_rut }: {
      periodo: string;
      tipo_doc: number;
      folio: number;
      empresa_rut?: string;
    }) => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify(
          await scraper.getDocumento(periodo, operacion, tipo_doc, folio, empresa_rut),
          null,
          2
        ),
      }],
    });

  server.tool(
    'sii_dte_get_documento_emitido',
    'Un documento EMITIDO puntual, por tipo y folio, en Consultas DTE del SII. ' +
    'REQUIERE el período (AAAAMM): el SII entrega los documentos por período, así que un folio de otro ' +
    'mes responde encontrado=false — eso significa "no está en ESTE período", no que el documento no ' +
    'exista. Se buscan todas las secciones del tipo, así que no hace falta saber la sección. ' +
    ADVERTENCIA_CONTRAPARTE + ' ' + ADVERTENCIA_RCV + ' Es solo lectura.',
    schemaDocumento,
    handlerDocumento('EMITIDOS')
  );

  server.tool(
    'sii_dte_get_documento_recibido',
    'Un documento RECIBIDO puntual, por tipo y folio, en Consultas DTE del SII. ' +
    'REQUIERE el período (AAAAMM): el SII entrega los documentos por período, así que un folio de otro ' +
    'mes responde encontrado=false — eso significa "no está en ESTE período", no que el documento no ' +
    'exista. Se buscan todas las secciones del tipo, así que no hace falta saber la sección. ' +
    'La contraparte es el PROVEEDOR que emitió el documento y llega con contraparteRol="emisor". ' +
    ADVERTENCIA_CONTRAPARTE + ' ' + ADVERTENCIA_RCV + ' Es solo lectura.',
    schemaDocumento,
    handlerDocumento('RECIBIDOS')
  );
}
