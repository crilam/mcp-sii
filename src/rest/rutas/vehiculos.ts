import { z } from 'zod';
import * as core from '../../core/vehiculos';
import {
  schemaVehiculosBase, schemaMarcas, schemaModelos, schemaTasacion, refinarTasacion, MENSAJE_REFINE_TASACION,
} from '../../core/schemas/vehiculos';
import { RutaHandler, ejecutar, badRequest } from './comun';

// Tasación fiscal de vehículos, desde las planillas públicas del SII. Como
// indicadores: sin `rut`, sin credencial, sin registro de sesiones. Siguen
// pasando por el auth de tenant y el rate-limit del servidor.
const zodBase = z.object(schemaVehiculosBase);
const zodMarcas = z.object(schemaMarcas);
const zodModelos = z.object(schemaModelos);
const zodTasacion = z.object(schemaTasacion).refine(refinarTasacion, { message: MENSAJE_REFINE_TASACION });

export function registrarRutasVehiculos(rutas: Map<string, RutaHandler>): void {
  rutas.set('POST /v1/vehiculos/tipos', async body => {
    const p = zodBase.safeParse(body);
    if (!p.success) return badRequest(p.error);
    return ejecutar(() => core.tipos(p.data));
  });

  rutas.set('POST /v1/vehiculos/marcas', async body => {
    const p = zodMarcas.safeParse(body);
    if (!p.success) return badRequest(p.error);
    return ejecutar(() => core.marcas(p.data));
  });

  rutas.set('POST /v1/vehiculos/modelos', async body => {
    const p = zodModelos.safeParse(body);
    if (!p.success) return badRequest(p.error);
    return ejecutar(() => core.modelos(p.data));
  });

  rutas.set('POST /v1/vehiculos/tasacion', async body => {
    const p = zodTasacion.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { anio, categoria, codigo_sii, marca, modelo, version, anio_fabricacion } = p.data;
    return ejecutar(() => core.tasacion({
      anio, categoria, codigoSii: codigo_sii, marca, modelo, version, anioFabricacion: anio_fabricacion,
    }));
  });

  rutas.set('POST /v1/vehiculos/equipamiento', async body => {
    const p = zodBase.safeParse(body);
    if (!p.success) return badRequest(p.error);
    return ejecutar(() => core.equipamiento(p.data));
  });
}
