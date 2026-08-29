import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/misii';
import { schemaFichaContribuyente } from '../core/schemas/misii';

export function registerMisiiTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_misii_ficha_contribuyente',
    'Ficha tributaria del contribuyente autenticado, tal como la publica el portal privado del SII ' +
    '("Mi información tributaria"): razón social, tipo y subtipo de contribuyente, fecha de constitución, ' +
    'inicio de actividades, término de giro, segmento, domicilios, actividades económicas con su fecha de ' +
    'inicio, y los atributos del registro (facturador electrónico, empresa de menor tamaño, régimen). ' +
    'Es una sola consulta: el portal entrega todo en la misma página, así que no hay que pedir cada parte ' +
    'por separado. ' +
    'IMPORTANTE sobre el régimen tributario: `regimen` es el VIGENTE y el portal NO guarda el anterior. ' +
    'Trae `desde`, y ese dato no es decorativo — es lo único que dice para qué períodos vale la respuesta. ' +
    'Para un período anterior a `desde`, este dato NO es el régimen que corresponde: hay que buscarlo en ' +
    'otra fuente y nunca extrapolar el actual hacia atrás. Si no hay atributo de régimen, `regimen` viene ' +
    'en null, que significa "no se pudo determinar", nunca un régimen supuesto. ' +
    'El código de régimen se entrega tal como lo da el SII (por ejemplo 14D1 con su glosa), sin traducirlo ' +
    'a una clasificación propia: sólo se relevó uno, y clasificar los demás a ciegas daría un régimen ' +
    'plausible y equivocado. ' +
    'Los representantes legales y los socios NO vienen acá: el portal muestra esos bloques vacíos ' +
    '(verificado en dos empresas de forma jurídica distinta), así que su ausencia no significa que el ' +
    'contribuyente no los tenga. ' +
    'Cada respuesta trae `capturadoEn` (cuándo se leyó del SII) y `parserVersion`, y `crudo` con el payload ' +
    'original sin normalizar.',
    schemaFichaContribuyente,
    async ({ rut }) => envolverParaMcp(() => core.fichaContribuyente(registro, rut))
  );
}
