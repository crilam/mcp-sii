import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OperacionDte } from '../scrapers/dte';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/dte';
import {
  schemaListado, schemaDocumento,
  ADVERTENCIA_RCV, ADVERTENCIA_SECCION, ADVERTENCIA_PERIODO, ADVERTENCIA_DETALLE,
  ADVERTENCIA_TOTALES, ADVERTENCIA_VACIO, ADVERTENCIA_CONTRAPARTE,
} from '../core/schemas/dte';

export function registerDteTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  const handler = (operacion: OperacionDte) =>
    async ({ rut, periodo, empresa_rut, tipo_doc, seccion, contraparte_rut, limit, incluir_detalle }: {
      rut: string; periodo: string; empresa_rut?: string; tipo_doc?: number;
      seccion?: string; contraparte_rut?: string; limit?: number; incluir_detalle: boolean;
    }) =>
      envolverParaMcp(() => core.listar(registro, rut, periodo, operacion, {
        empresaRut: empresa_rut, tipoDocCodigo: tipo_doc, seccion,
        contraparteRut: contraparte_rut, limit, incluirDetalle: incluir_detalle,
      }));

  server.tool(
    'sii_dte_list_documentos_emitidos',
    'Documentos tributarios electrónicos EMITIDOS por la empresa en un período, según Consultas DTE del ' +
    'SII: por defecto el resumen por (tipo de documento, sección), y con incluir_detalle=true además ' +
    'cada documento con su contraparte, folio, fechas y montos. ' +
    ADVERTENCIA_PERIODO + ' ' + ADVERTENCIA_DETALLE + ' ' +
    ADVERTENCIA_SECCION + ' ' + ADVERTENCIA_CONTRAPARTE + ' ' + ADVERTENCIA_TOTALES + ' ' +
    ADVERTENCIA_VACIO + ' ' + ADVERTENCIA_RCV + ' Es solo lectura.',
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
    ADVERTENCIA_VACIO + ' ' + ADVERTENCIA_RCV + ' Es solo lectura.',
    schemaListado(),
    handler('RECIBIDOS')
  );

  const handlerDocumento = (operacion: OperacionDte) =>
    async ({ rut, periodo, tipo_doc, folio, empresa_rut }: {
      rut: string; periodo: string; tipo_doc: number; folio: number; empresa_rut?: string;
    }) =>
      envolverParaMcp(() => core.getDocumento(registro, rut, periodo, operacion, tipo_doc, folio, empresa_rut));

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
