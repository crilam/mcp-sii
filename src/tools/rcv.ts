import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OperacionRcv, RcvScraper } from '../scrapers/rcv';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { conErroresDeSesion, SesionNoIniciada } from '../erroresSesion';

const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

async function conScraper<R>(
  registro: RegistroSesiones<SessionManager>,
  rut: string,
  fn: (scraper: RcvScraper) => Promise<R>
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const resultado = await conErroresDeSesion(() =>
    registro.ejecutar(rut, async sesion => {
      const scraper = new RcvScraper(new SiiHttpClient(sesion), sesion);
      return fn(scraper);
    })
  ).catch(e => {
    if (e instanceof SesionNoIniciada) {
      return { __error: 'SESION_NO_INICIADA' as const };
    }
    throw e;
  });

  if (resultado && typeof resultado === 'object' && '__error' in resultado) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: resultado.__error }) }],
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
  };
}

export function registerRcvTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_rcv_resumen',
    'Resumen del Registro de Compras y Ventas de un período tributario: los totales por tipo de documento ' +
    '(cantidad de documentos, neto, exento, IVA y total), el total de documentos del período y la fecha de ' +
    'última actualización del registro. El campo `totales` viene con las notas de crédito (tipos 61 y 60) ' +
    'RESTADAS, que es como corresponde totalizar: sumarlas infla las ventas y el IVA. ' +
    'Si aparece un tipo de documento que el servidor no tiene catalogado, se suma a los totales pero la ' +
    'respuesta trae totalesConfiables=false, tiposDesconocidos y advertencias: en ese caso hay que avisar ' +
    'que los totales pueden estar mal antes de usarlos. ' +
    'Si el período no tiene documentos registrados, responde sinDatos=true con los totales en cero: es un ' +
    'mes sin movimientos, no un error (el campo mensaje explica el vacío cuando el SII lo explica, por ' +
    'ejemplo si el período es anterior al que cubre el registro). ' +
    'La empresa es un parámetro de la consulta, no de la sesión: se puede pasar empresa_rut distinto en ' +
    'cada llamada, sin seleccionar empresa; si se omite, se consulta el RUT autenticado. ' +
    'Es solo lectura: no acepta ni reclama documentos.',
    {
      rut: z.string().describe(RUT_DESC),
      periodo: z.string().regex(/^\d{6}$/)
        .describe('Período tributario en formato AAAAMM (por ejemplo 202607)'),
      operacion: z.enum(['COMPRA', 'VENTA'])
        .describe('COMPRA para el registro de compras, VENTA para el de ventas'),
      empresa_rut: z.string().optional()
        .describe('RUT de la empresa a consultar, con dígito verificador (22222222-2). Si se omite, se usa el RUT autenticado.'),
    },
    async ({ rut, periodo, operacion, empresa_rut }: {
      rut: string;
      periodo: string;
      operacion: OperacionRcv;
      empresa_rut?: string;
    }) => conScraper(registro, rut, scraper => scraper.resumen(periodo, operacion, empresa_rut))
  );

  server.tool(
    'sii_rcv_detalle',
    'Detalle documento por documento del Registro de Compras y Ventas de un período: para cada documento, ' +
    'la contraparte (RUT y razón social), el folio, la fecha de emisión, los montos neto/exento/IVA/total, ' +
    'el documento referenciado y el estado de aceptación o reclamo del receptor. ' +
    'REQUIERE el código de tipo de documento (tipo_doc): el SII entrega el detalle por tipo de documento, ' +
    'NO del período entero. Ese código sale de sii_rcv_resumen, en filas[].tipoDocCodigo, así que el orden ' +
    'es: primero sii_rcv_resumen para ver qué tipos hay en el período, después sii_rcv_detalle por cada ' +
    'tipo que interese (33 factura electrónica, 61 nota de crédito, 46 factura de compra, 34 exenta, ' +
    '110 exportación, 914 DIN, 56 nota de débito). ' +
    'La contraparte se informa con contraparteRol: en COMPRA es el emisor (el proveedor) y en VENTA es el ' +
    'receptor (el cliente); no hay que llamarla proveedor en una consulta de ventas. ' +
    'En notas de crédito y débito, referenciaTipoDoc y referenciaFolio dicen qué documento se está ' +
    'corrigiendo. ' +
    'CUIDADO con la contraparte en documentos de EXPORTACIÓN (tipos 110, 111 y 112): el cliente es ' +
    'extranjero y NO tiene RUT chileno, así que el SII pone el RUT genérico 55555555-5 en contraparteRut ' +
    'para TODOS los receptores extranjeros. Ese RUT no identifica a nadie y se repite entre clientes ' +
    'distintos: no sirve para agrupar, comparar ni cruzar. Hay que mirar contraparteTipoId: vale ' +
    '"rut_chileno" cuando contraparteRut identifica de verdad a la contraparte, y "extranjero" cuando no. ' +
    'Con "extranjero", el identificador real de la contraparte está en contraparteIdExtranjero (su RUC, ' +
    'VAT o tax id de origen; null si el SII no lo informa) y contraparteNacionalidadCodigo trae la ' +
    'nacionalidad como CÓDIGO NUMÉRICO de la tabla de países del SII (por ejemplo 218), no como nombre de ' +
    'país: no hay que traducirlo ni adivinar de qué país se trata, se reporta el código tal cual. ' +
    'CUIDADO al sumar: en las notas de crédito (tipos 61 y 60) los montos vienen POSITIVOS pero RESTAN ' +
    'del total del período, así que sumar los montoTotal de un detalle produce un total mal. Para ' +
    'totalizar hay que usar sii_rcv_resumen, que ya aplica el signo; este detalle es para mirar ' +
    'documento por documento. ' +
    'Si el período o el tipo no tienen documentos registrados, responde sinDatos=true con documentos=[]: ' +
    'es un vacío legítimo, no un error (el campo mensaje explica el vacío cuando el SII lo explica). ' +
    'La empresa es un parámetro de la consulta, no de la sesión: se puede pasar empresa_rut distinto en ' +
    'cada llamada; si se omite, se consulta el RUT autenticado. ' +
    'Es solo lectura: no acepta ni reclama documentos.',
    {
      rut: z.string().describe(RUT_DESC),
      periodo: z.string().regex(/^\d{6}$/)
        .describe('Período tributario en formato AAAAMM (por ejemplo 202607)'),
      operacion: z.enum(['COMPRA', 'VENTA'])
        .describe('COMPRA para el registro de compras, VENTA para el de ventas'),
      tipo_doc: z.number().int().positive()
        .describe('Código del tipo de documento, obligatorio. Se obtiene de sii_rcv_resumen en filas[].tipoDocCodigo (33 factura electrónica, 61 nota de crédito, 46 factura de compra, 34 exenta, 110 exportación, 914 DIN, 56 nota de débito)'),
      empresa_rut: z.string().optional()
        .describe('RUT de la empresa a consultar, con dígito verificador (22222222-2). Si se omite, se usa el RUT autenticado.'),
    },
    async ({ rut, periodo, operacion, tipo_doc, empresa_rut }: {
      rut: string;
      periodo: string;
      operacion: OperacionRcv;
      tipo_doc: number;
      empresa_rut?: string;
    }) => conScraper(registro, rut, scraper => scraper.detalle(periodo, operacion, tipo_doc, empresa_rut))
  );
}
