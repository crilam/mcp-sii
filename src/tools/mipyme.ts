import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MipymeHttpScraper } from '../scrapers/mipymeHttp';
import { getConfig } from '../env';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { conErroresDeSesion, SesionNoIniciada } from '../erroresSesion';

const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

// Corre `fn` con el scraper armado para la sesión del `rut` pedido y devuelve
// ya el `content` de la tool: si no hay sesión iniciada para ese RUT, en vez
// de propagar la excepción responde { ok: false, error: 'SESION_NO_INICIADA' },
// que es el contrato que puede leer un modelo sin que la tool explote.
async function conScraper<R>(
  registro: RegistroSesiones<SessionManager>,
  rut: string,
  fn: (http: MipymeHttpScraper) => Promise<R>
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const resultado = await conErroresDeSesion(() =>
    registro.ejecutar(rut, async sesion => {
      const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
      return fn(http);
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

const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Formato YYYY-MM-DD');

// Orden de resolución de la empresa, el mismo que el resto del proyecto: el
// parámetro de la llamada gana, si no vino cae a SII_EMPRESA_RUT, y si tampoco
// hay, el scraper la resuelve solo cuando este RUT opera una única empresa
// (con varias, falla listándolas). No se exige acá para no romper el contrato
// que tenía la tool con el navegador.
function empresaPedida(empresaRut?: string): string | undefined {
  return empresaRut ?? getConfig().empresaRut;
}

export function registerMipymeTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_mipyme_list_empresas',
    'Lista las empresas que la persona autenticada puede operar en el Sistema de Facturación ' +
    'Gratuito del SII (mipyme.sii.cl). Usar antes de otras tools cuando SII_EMPRESA_RUT no está ' +
    'configurado. OJO: esta lista es la del portal mipyme y NO coincide con la de otras ' +
    'aplicaciones del SII — el Registro de Compras y Ventas y Consultas DTE habilitan su propio ' +
    'conjunto de empresas, que puede ser más amplio.',
    {
      rut: z.string().describe(RUT_DESC),
    },
    async ({ rut }) => conScraper(registro, rut, http => http.listEmpresas())
  );

  server.tool(
    'sii_mipyme_list_dte_emitidos',
    'Lista el historial de DTE emitidos en el Sistema de Facturación Gratuito del SII ' +
    '(mipyme.sii.cl): folio, tipo, receptor, monto y estado de cada documento. Sin filtros de ' +
    'fecha devuelve el historial completo de la empresa, no el período actual. Entrega de a 100 ' +
    'documentos por página: usá "pagina" para las siguientes. Cubre sólo lo emitido POR ESTE ' +
    'portal, así que puede no coincidir con sii_dte_list_documentos_emitidos ni con sii_rcv_*, ' +
    'que consultan otros registros del SII.',
    {
      rut: z.string().describe(RUT_DESC),
      empresa_rut: z.string().optional().describe('RUT de la empresa con dígito verificador. Si se omite, usa SII_EMPRESA_RUT, o se resuelve solo si este RUT opera una única empresa en el portal.'),
      tipo_dte: z.number().int().optional().describe('Filtrar por tipo: 33=factura, 34=exenta, 61=N.crédito, 56=N.débito, 52=guía, 46=F.compra'),
      fecha_desde: FechaSchema,
      fecha_hasta: FechaSchema,
      receptor_rut: z.string().optional().describe('Filtrar por RUT del receptor'),
      folio: z.number().int().optional().describe('Filtrar por folio exacto'),
      pagina: z.number().int().min(1).default(1).describe('Página del historial (100 documentos por página)'),
    },
    async ({ rut, empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, folio, pagina }) =>
      conScraper(registro, rut, http => http.listDteEmitidos({
        empresaRut: empresaPedida(empresa_rut),
        tipoDte: tipo_dte,
        fechaDesde: fecha_desde,
        fechaHasta: fecha_hasta,
        receptorRut: receptor_rut,
        folio,
        pagina,
      }))
  );

  server.tool(
    'sii_mipyme_emitir_dte',
    'Emite una factura (33), factura exenta (34) o nota de crédito (61) en el Sistema de ' +
    'Facturación Gratuito del SII (mipyme.sii.cl). POR DEFECTO NO EMITE: devuelve la ' +
    'previsualización con los montos que calculó el propio SII, para revisarlos. Sólo con ' +
    'confirmar=true firma y envía el documento, y eso es un acto tributario REAL E ' +
    'IRREVERSIBLE que notifica al receptor y sólo se deshace con una nota de crédito: pedí ' +
    'autorización explícita del usuario antes de mandar confirmar=true, nunca lo uses para ' +
    'probar. Firmar requiere que el contribuyente tenga su certificado digital cargado en el ' +
    'SII y la clave en SII_CERT_CLAVE_SII (o SII_CERT_PASSWORD). En una factura afecta el IVA ' +
    'se redondea, así que el neto mínimo emisible es 3: con 1 ó 2 el IVA da 0 y el portal la ' +
    'rechaza.',
    {
      rut: z.string().describe(RUT_DESC),
      empresa_rut: z.string().optional().describe('RUT empresa. Si se omite, usa SII_EMPRESA_RUT, o se resuelve solo si la persona opera una única empresa.'),
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
    },
    async (args) =>
      conScraper(registro, args.rut, async http => {
        const resultado = await http.emitirDte(
          {
            empresaRut: empresaPedida(args.empresa_rut),
            tipoDte: args.tipo_dte,
            receptor: {
              rut: args.receptor_rut,
              dv: args.receptor_dv,
              razonSocial: args.receptor_razon_social,
              giro: args.receptor_giro,
              direccion: args.receptor_direccion,
              comuna: args.receptor_comuna,
              ciudad: args.receptor_ciudad,
            },
            lineas: args.lineas.map(l => ({
              nombre: l.descripcion,
              cantidad: l.cantidad,
              precioUnitario: l.precio_unitario,
              unidad: l.unidad,
            })),
            formaPago: args.forma_pago,
            ciudadEmisor: args.ciudad_emisor,
            fechaEmision: args.fecha_emision,
            referencias: args.referencias?.map(r => ({
              tipoDoc: r.tipo_doc,
              folio: r.folio,
              fecha: r.fecha,
              razon: r.razon,
              codigo: r.codigo,
            })),
          },
          args.confirmar
        );

        // Los 243 campos del documento no le sirven a nadie leyéndolo y tapan el
        // resumen, que es lo que hay que revisar antes de confirmar.
        return resultado.emitido
          ? {
              emitido: true,
              folio: resultado.folio,
              resumen: resultado.resumen,
              // El folio sale de la página de firma (el propuesto por el portal).
              // La respuesta de mipeSendXML.cgi no está relevada, así que no se
              // puede afirmar que sea el folio asignado: hay que confirmarlo. Es
              // la salvedad que evita repetir el falso positivo del "folio 21".
              aviso: `Documento emitido. El folio ${resultado.folio} es el que propuso el ` +
                'portal; hay que verificar que quedó asignado consultando ' +
                'sii_mipyme_list_dte_emitidos (la respuesta del envío aún no está relevada).',
            }
          : {
              emitido: false,
              resumen: resultado.resumen,
              aviso: 'Documento NO emitido: esto es sólo la previsualización. Para emitirlo de ' +
                'verdad hay que llamar de nuevo con confirmar=true, y eso es irreversible.',
            };
      })
  );
}
