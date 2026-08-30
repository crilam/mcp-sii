import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RegistroSesiones } from '../registroSesiones';
import { SessionManager } from '../session';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/f29';
import { schemaEstadoF29 } from '../core/schemas/f29';

export function registerF29Tools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_f29_estado_declaracion',
    'Estado de la declaración de Formulario 29 (IVA mensual) de un período (AAAAMM): folio, estado (Vigente, Anulada...), si tiene observaciones, fecha de presentación y moneda. Un período sin declaración vigente responde NO_ENCONTRADO. El PDF del formulario compacto se pide aparte por REST (/v1/f29/formulario-compacto): un PDF en base64 satura el contexto del modelo.',
    schemaEstadoF29,
    async ({ rut, periodo }) => envolverParaMcp(() => core.estadoDeclaracion(registro, rut, periodo))
  );
}
