import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConfig } from '../env';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/mipyme';
import { schemaListEmpresas, schemaListDteEmitidos, schemaListDteRecibidos, schemaListBorradores, schemaEmitirDte } from '../core/schemas/mipyme';

// Orden de resolución de la empresa, el mismo que el resto del proyecto: el
// parámetro de la llamada gana, si no vino cae a SII_EMPRESA_RUT, y si tampoco
// hay, el scraper la resuelve solo cuando este RUT opera una única empresa
// (con varias, falla listándolas). Sólo aplica al MCP — el REST no tiene este
// fallback (ver src/rest/rutas/mipyme.ts).
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
    schemaListEmpresas,
    async ({ rut }) => envolverParaMcp(() => core.listEmpresas(registro, rut))
  );

  server.tool(
    'sii_mipyme_list_dte_emitidos',
    'Lista el historial de DTE emitidos en el Sistema de Facturación Gratuito del SII ' +
    '(mipyme.sii.cl): folio, tipo, receptor, monto y estado de cada documento. Sin filtros de ' +
    'fecha devuelve el historial completo de la empresa, no el período actual. Entrega de a 100 ' +
    'documentos por página: usá "pagina" para las siguientes. Cubre sólo lo emitido POR ESTE ' +
    'portal, así que puede no coincidir con sii_dte_list_documentos_emitidos ni con sii_rcv_*, ' +
    'que consultan otros registros del SII.',
    schemaListDteEmitidos,
    async ({ rut, empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, folio, pagina }) =>
      envolverParaMcp(() => core.listDteEmitidos(registro, rut, {
        empresaRut: empresaPedida(empresa_rut), tipoDte: tipo_dte, fechaDesde: fecha_desde,
        fechaHasta: fecha_hasta, receptorRut: receptor_rut, folio, pagina,
      }))
  );

  server.tool(
    'sii_mipyme_list_dte_recibidos',
    'Lista los DTE RECIBIDOS por la empresa en el Sistema de Facturación Gratuito del SII: ' +
    'folio, tipo, emisor, monto y estado de acuse de cada documento. Es el lado espejo de ' +
    'sii_mipyme_list_dte_emitidos y comparte su forma, con el EMISOR como contraparte en vez ' +
    'del receptor. Sin filtros de fecha devuelve el historial completo, no el período actual, ' +
    'y entrega de a 100 documentos por página: usá "pagina" para las siguientes. El campo ' +
    '"estado" es el del acuse (por ejemplo "DTE Recibido Sin Reparos"), que es información ' +
    'que sii_rcv_* no tiene.',
    schemaListDteRecibidos,
    async ({ rut, empresa_rut, tipo_dte, fecha_desde, fecha_hasta, emisor_rut, folio, pagina }) =>
      envolverParaMcp(() => core.listDteRecibidos(registro, rut, {
        empresaRut: empresaPedida(empresa_rut), tipoDte: tipo_dte, fechaDesde: fecha_desde,
        fechaHasta: fecha_hasta, emisorRut: emisor_rut, folio, pagina,
      }))
  );

  server.tool(
    'sii_mipyme_list_borradores',
    'Lista los borradores de DTE guardados en el portal de Facturación Gratuita. Devuelve el ' +
    'código de cada borrador, su tipo de documento y TODOS los campos tal como los nombra el ' +
    'SII (EFXP_*, sin renombrar): un borrador tiene decenas de campos que dependen del tipo, ' +
    'y cuáles importan lo decide quien consulta. Los borradores viven en otra aplicación del ' +
    'SII, no en el portal clásico. Los borradores cuelgan de la EMPRESA ACTIVA: si ' +
    'el RUT opera varias, pasá empresa_rut — sin él se responden los borradores de ' +
    'la empresa que dejó la consulta anterior, y una lista vacía se lee como "no hay ' +
    'borradores" en vez de "preguntaste por otra empresa".',
    schemaListBorradores,
    async ({ rut, empresa_rut }) =>
      envolverParaMcp(() => core.listBorradores(registro, rut, empresaPedida(empresa_rut)))
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
    schemaEmitirDte,
    async (args) => envolverParaMcp(async () => {
      const resultado = await core.emitirDte(registro, args.rut, {
        empresaRut: empresaPedida(args.empresa_rut),
        tipoDte: args.tipo_dte,
        receptor: {
          rut: args.receptor_rut, dv: args.receptor_dv, razonSocial: args.receptor_razon_social,
          giro: args.receptor_giro, direccion: args.receptor_direccion, comuna: args.receptor_comuna,
          ciudad: args.receptor_ciudad,
        },
        lineas: args.lineas.map(l => ({
          nombre: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precio_unitario, unidad: l.unidad,
        })),
        formaPago: args.forma_pago,
        ciudadEmisor: args.ciudad_emisor,
        fechaEmision: args.fecha_emision,
        referencias: args.referencias?.map(r => ({
          tipoDoc: r.tipo_doc, folio: r.folio, fecha: r.fecha, razon: r.razon, codigo: r.codigo,
        })),
      }, args.confirmar);

      return resultado.emitido
        ? {
            emitido: true, folio: resultado.folio, resumen: resultado.resumen,
            aviso: `Documento emitido. El folio ${resultado.folio} es el que propuso el ` +
              'portal; hay que verificar que quedó asignado consultando ' +
              'sii_mipyme_list_dte_emitidos (la respuesta del envío aún no está relevada).',
          }
        : {
            emitido: false, resumen: resultado.resumen,
            aviso: 'Documento NO emitido: esto es sólo la previsualización. Para emitirlo de ' +
              'verdad hay que llamar de nuevo con confirmar=true, y eso es irreversible.',
          };
    })
  );
}
