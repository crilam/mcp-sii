import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/actividadesEconomicas';
import { schemaActividades, schemaActividad, schemaVerificarRut } from '../core/schemas/actividadesEconomicas';

export function registerActividadesEconomicasTools(server: McpServer): void {
  server.tool(
    'sii_actividades_economicas',
    'Códigos de actividad económica del SII (los ~670 códigos de seis dígitos), con rubro, subrubro, si afecta IVA, categoría tributaria y si está disponible para iniciar actividades por internet. Filtrable por categoría ("1"/"2"), IVA y texto. Sin credencial: es una tabla pública. La categoría viene tal como la publica el SII, que usa alguna letra ("G") para casos que no explica.',
    schemaActividades,
    async ({ categoria, afecta_iva, texto }) =>
      envolverParaMcp(() => core.actividades({ categoria, afectaIva: afecta_iva, texto }))
  );

  server.tool(
    'sii_actividad_economica',
    'Una actividad económica por su código de seis dígitos. Un código que el SII no publica responde NO_ENCONTRADO.',
    schemaActividad,
    async ({ codigo }) => envolverParaMcp(() => core.actividad(codigo))
  );

  server.tool(
    'sii_verificar_rut',
    'Verifica el formato y el dígito verificador (módulo 11) de un RUT chileno. NO consulta al SII y NO dice si el RUT existe o a quién pertenece —para eso está sii_contribuyente_situacion_tributaria—: sólo si está bien formado. Devuelve el RUT normalizado y, si es inválido, el dígito que correspondería.',
    schemaVerificarRut,
    async ({ rut }) => envolverParaMcp(async () => core.verificarRut(rut))
  );
}
