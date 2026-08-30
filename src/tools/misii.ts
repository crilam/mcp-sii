import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RegistroSesiones } from '../registroSesiones';
import { SessionManager } from '../session';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/misii';
import { schemaDatosContribuyente } from '../core/schemas/misii';

export function registerMisiiTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_misii_datos_contribuyente',
    'Datos del contribuyente autenticado según Mi SII: RUT, razón social o nombres, tipo y subtipo de contribuyente, segmento (micro, pequeña, mediana, gran empresa o persona), glosa de actividad, fechas de constitución, inicio de actividades y término de giro, capital, direcciones vigentes con comuna y región, atributos (regímenes y autorizaciones con su vigencia) y las actividades económicas del contribuyente con la fecha desde la que tiene cada una. ' +
    'IMPORTANTE sobre `regimen`: es el régimen tributario VIGENTE y el portal NO guarda el anterior. Trae `desde`, y ese dato no es decorativo — es lo único que dice para qué períodos vale la respuesta. Para un período anterior a `desde` este NO es el régimen que corresponde: hay que buscarlo en otra fuente y nunca extrapolar el actual hacia atrás. Si viene en null significa "no se pudo determinar", nunca un régimen supuesto, y el código va tal como lo da el SII (por ejemplo 14D1 con su glosa) sin traducirlo a una clasificación propia. ' +
    'Cada respuesta trae `capturadoEn` (cuándo se leyó del SII) y `parserVersion`. La ficha incluye datos personales (correo, teléfono, capital), así que no conviene volcarla entera en un log. ' +
    'No trae representantes, socios ni giros: el portal sirve esas secciones vacías, verificado en dos empresas de forma jurídica distinta, así que su ausencia no significa que el contribuyente no los tenga.',
    schemaDatosContribuyente,
    async ({ rut }) => envolverParaMcp(() => core.datosContribuyente(registro, rut))
  );
}
