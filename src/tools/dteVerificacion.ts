import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RegistroSesiones } from '../registroSesiones';
import { SessionManager } from '../session';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/dteVerificacion';
import { schemaValidezDte, schemaContenidoDte } from '../core/schemas/dteVerificacion';

export function registerDteVerificacionTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_dte_validez',
    'Consulta si un DTE (por RUT emisor, tipo y folio) fue recibido por el SII. Devuelve el veredicto en `resultado` ("Documento recibido por el SII" o "Documento no autorizado"), `recibidoPorElSii`, el nombre del emisor y el identificador de envío. Requiere sesión: el SII cerró esta consulta detrás del login.',
    schemaValidezDte,
    async ({ rut, rut_emisor, tipo_dte, folio }) =>
      envolverParaMcp(() => core.validez(registro, rut, { rutEmisor: rut_emisor, tipoDte: tipo_dte, folio }))
  );

  server.tool(
    'sii_dte_verificar',
    'Verifica que los datos de un DTE que uno tiene (emisor, receptor, tipo, folio, fecha y monto total) coincidan con los que el emisor informó al SII. `datosCoinciden` es el veredicto; `resultado` trae el texto del SII ("Datos coinciden con los registrados" o "datos NO coinciden"). Sirve para validar una factura recibida antes de pagarla. Requiere sesión.',
    schemaContenidoDte,
    async ({ rut, rut_emisor, tipo_dte, folio, rut_receptor, fecha_emision, monto_total }) =>
      envolverParaMcp(() => core.contenido(registro, rut, {
        rutEmisor: rut_emisor, tipoDte: tipo_dte, folio,
        rutReceptor: rut_receptor, fechaEmision: fecha_emision, montoTotal: monto_total,
      }))
  );
}
