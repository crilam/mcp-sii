import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/indicadores';
import { schemaAnio } from '../core/schemas/indicadores';

// Las únicas tools que NO reciben `rut` ni necesitan `sii_iniciar_sesion`: el SII
// publica estas tablas abiertas.
export function registerIndicadoresTools(server: McpServer): void {
  server.tool(
    'sii_indicadores_uf',
    'Valores diarios de la UF publicados por el SII para un año. Devuelve una entrada por día con mes, día y valor. NO requiere sesión ni credencial: es una página pública. Los días que el SII no publicó (feriados, o los que faltan del año en curso) NO aparecen, en vez de aparecer en cero.',
    schemaAnio,
    async ({ anio }) => envolverParaMcp(() => core.uf(anio))
  );

  server.tool(
    'sii_indicadores_dolar',
    'Valores diarios del dólar observado publicados por el SII para un año. Misma forma que la UF: una entrada por día. Sólo trae días hábiles — el dólar no se publica fines de semana ni feriados, y esos días no aparecen. NO requiere sesión ni credencial.',
    schemaAnio,
    async ({ anio }) => envolverParaMcp(() => core.dolar(anio))
  );

  server.tool(
    'sii_indicadores_utm',
    'UTM, UTA e IPC por mes para un año, como los publica el SII. Devuelve una entrada por mes con los valores en el ORDEN de la tabla del portal (UTM, UTA, IPC y variaciones): no se les pone nombre propio porque las columnas cambian entre tablas y nombrarlas sería inventar semántica. NO requiere sesión ni credencial.',
    schemaAnio,
    async ({ anio }) => envolverParaMcp(() => core.utm(anio))
  );

  server.tool(
    'sii_indicadores_correccion_monetaria',
    'Factores de corrección monetaria por mes para un año. La tabla es triangular —un mes no tiene factor contra los meses anteriores— así que muchas celdas vienen en null, y ese null significa "no corresponde", no cero. NO requiere sesión ni credencial.',
    schemaAnio,
    async ({ anio }) => envolverParaMcp(() => core.correccionMonetaria(anio))
  );

  server.tool(
    'sii_indicadores_impuesto_2da_categoria',
    'Tramos del impuesto único de segunda categoría (artículo 43 de la Ley de la Renta) por mes. Devuelve un tramo por fila con mes, período (MENSUAL, QUINCENAL, SEMANAL o DIARIO), renta desde/hasta, factor, cantidad a rebajar y tasa efectiva máxima. El primer tramo de cada período viene con exento=true y los números en null: no es un factor cero, es que no se aplica impuesto. NO requiere sesión ni credencial.',
    schemaAnio,
    async ({ anio }) => envolverParaMcp(() => core.impuesto2daCategoria(anio))
  );

  server.tool(
    'sii_indicadores_impuesto_2da_categoria_art52',
    'Tramos del impuesto único de segunda categoría del artículo 52 bis (rentas de autoridades y funcionarios que la ley grava aparte). Misma forma que la tabla del artículo 43, pero sólo con el período MENSUAL. NO requiere sesión ni credencial.',
    schemaAnio,
    async ({ anio }) => envolverParaMcp(() => core.impuesto2daCategoriaArt52(anio))
  );
}
