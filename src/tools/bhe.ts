import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/bhe';
import { schemaResumen, schemaMes } from '../core/schemas/bhe';

export function registerBheTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_bhe_resumen',
    'Resumen anual de las boletas de honorarios electrónicas EMITIDAS por el RUT persona autenticado en el SII. Devuelve siempre los doce meses del año, en orden: el honorario bruto, la retención de terceros y del contribuyente, el rango de folios y cuántas boletas están vigentes o anuladas. Un mes sin actividad viene en cero y con los folios en null. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaResumen,
    async ({ rut, anio }) => envolverParaMcp(() => core.resumen(registro, rut, anio))
  );

  server.tool(
    'sii_bhe_resumen_recibidas',
    'Resumen anual de las boletas de honorarios electrónicas RECIBIDAS por el RUT persona autenticado. Mismos campos y misma forma que sii_bhe_resumen, y también los doce meses siempre, salvo que folioInicial y folioFinal vienen siempre en null: el portal no muestra folios en este informe, y un rango no significaría nada porque cada boleta la folió un emisor distinto. Ojo: no equivale a sumar sii_bhe_list_recibidas — el SII informa acá una retención del contribuyente que el listado mensual de recibidas no muestra.',
    schemaResumen,
    async ({ rut, anio }) => envolverParaMcp(() => core.resumenRecibidas(registro, rut, anio))
  );

  server.tool(
    'sii_bhe_list_emitidas',
    'Lista boleta por boleta las boletas de honorarios electrónicas emitidas por el RUT persona autenticado en un mes: folio, fecha, receptor de la boleta (en contraparteRut/contraparteNombre, con contraparteRol="receptor"), honorario bruto, retención del emisor y del receptor, total líquido y si está anulada. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaMes,
    async ({ rut, anio, mes }) => envolverParaMcp(() => core.listEmitidas(registro, rut, anio, mes))
  );

  server.tool(
    'sii_bhe_list_recibidas',
    'Lista las boletas de honorarios electrónicas recibidas por el RUT persona autenticado en un mes: folio, fecha, emisor de la boleta (en contraparteRut/contraparteNombre, con contraparteRol="emisor"), honorario bruto, retención del receptor, total líquido y si está anulada. El SII no informa la retención del emisor en las recibidas, así que retencionEmisor viene en null. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaMes,
    async ({ rut, anio, mes }) => envolverParaMcp(() => core.listRecibidas(registro, rut, anio, mes))
  );
}
