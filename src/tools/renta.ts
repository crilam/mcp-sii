import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/renta';
import { schemaEstadoDeclaracion, schemaF22 } from '../core/schemas/renta';

export function registerRentaTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_renta_estado_declaracion',
    'Estado de la declaración de renta (Formulario 22) del RUT persona autenticado para un año tributario. ' +
    'Devuelve las declaraciones del año (folio, si es la vigente, código de estado, domicilio, fecha de ' +
    'vencimiento y remanente solicitado/devuelto) junto con las glosas: el texto del SII que explica el ' +
    'estado —si hubo devolución y por cuánto, o qué inconsistencia se detectó—, que es lo más útil de la ' +
    'respuesta. Si el año no tiene declaración, responde sinDatos=true con las listas vacías: es un vacío ' +
    'legítimo, no un error. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaEstadoDeclaracion,
    async ({ rut, anio }) => envolverParaMcp(() => core.estadoDeclaracion(registro, rut, anio))
  );

  server.tool(
    'sii_renta_get_f22',
    'Formulario 22 completo de un año tributario del RUT persona autenticado: la lista de todos los códigos ' +
    'del formulario con su valor y su glosa. Si se omite el folio, se resuelve solo consultando la ' +
    'declaración vigente del año (una consulta extra al SII); si ese año no tiene una declaración vigente, ' +
    'falla pidiendo el folio explícito en vez de devolver un formulario vacío. ' +
    'No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaF22,
    async ({ rut, anio, folio }) => envolverParaMcp(() => core.f22Completo(registro, rut, anio, folio))
  );
}
