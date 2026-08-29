import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RegistroSesiones } from '../registroSesiones';
import { SessionManager } from '../session';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/misii';
import { schemaDatosContribuyente } from '../core/schemas/misii';

export function registerMisiiTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_misii_datos_contribuyente',
    'Datos del contribuyente autenticado según Mi SII: RUT, razón social o nombres, tipo y subtipo de contribuyente, segmento (micro, pequeña, mediana, gran empresa o persona), glosa de actividad, fechas de constitución, inicio de actividades y término de giro, capital, direcciones vigentes con comuna y región, y atributos (regímenes tributarios y autorizaciones, con su vigencia). Es la ficha del contribuyente que el SII muestra en la home de Mi SII. No trae representantes, socios ni giros: esas secciones no se pudieron relevar con datos.',
    schemaDatosContribuyente,
    async ({ rut }) => envolverParaMcp(() => core.datosContribuyente(registro, rut))
  );
}
