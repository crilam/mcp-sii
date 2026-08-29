import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/vehiculos';
import { schemaVehiculosBase, schemaMarcas, schemaModelos, schemaTasacion } from '../core/schemas/vehiculos';

// Tasación fiscal de vehículos. Sin `rut` ni sesión: el SII publica las
// planillas abiertas. La primera consulta de un año baja la planilla entera
// (~7 MB, unos segundos); las siguientes salen de memoria.
export function registerVehiculosTools(server: McpServer): void {
  server.tool(
    'sii_vehiculos_tipos',
    'Tipos de vehículo de la planilla de tasación fiscal del SII para un año (Sedán, Suv, Camioneta, Moto...). Sin credencial. La primera consulta de un año tarda unos segundos porque baja la planilla completa; después es instantánea.',
    schemaVehiculosBase,
    async (f) => envolverParaMcp(() => core.tipos(f))
  );

  server.tool(
    'sii_vehiculos_marcas',
    'Marcas de la planilla de tasación fiscal del SII para un año, opcionalmente filtradas por tipo. Sin credencial.',
    schemaMarcas,
    async (f) => envolverParaMcp(() => core.marcas(f))
  );

  server.tool(
    'sii_vehiculos_modelos',
    'Modelos de una marca en la planilla de tasación, con sus versiones y los años de fabricación tasados. Es el paso previo a pedir una tasación sin conocer el código SII. Una marca inexistente responde NO_ENCONTRADO.',
    schemaModelos,
    async (f) => envolverParaMcp(() => core.modelos(f))
  );

  server.tool(
    'sii_vehiculos_tasacion',
    'Tasación fiscal y valor del permiso de circulación de un vehículo, por código SII o por marca + modelo (+ versión, + año de fabricación). Devuelve TODAS las filas que coinciden —un modelo tiene una por año de fabricación y por versión— en vez de elegir una. La tasación es la del AÑO de la planilla; el permiso sólo viene para livianos (pesados lo traen en null).',
    schemaTasacion,
    async ({ anio, categoria, codigo_sii, marca, modelo, version, anio_fabricacion }) =>
      envolverParaMcp(() => core.tasacion({
        anio, categoria, codigoSii: codigo_sii, marca, modelo, version, anioFabricacion: anio_fabricacion,
      }))
  );

  server.tool(
    'sii_vehiculos_equipamiento',
    'Diccionario de siglas de equipamiento de la planilla de tasación (por ejemplo "AA" → "Aire Acondicionado"). El campo `equipamiento` de una tasación es una lista de estas siglas; sin el diccionario no se puede leer. Sólo la planilla de livianos lo trae.',
    schemaVehiculosBase,
    async (f) => envolverParaMcp(() => core.equipamiento(f))
  );
}
