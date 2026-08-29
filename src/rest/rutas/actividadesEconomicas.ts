import { z } from 'zod';
import * as core from '../../core/actividadesEconomicas';
import { schemaActividades, schemaActividad, schemaVerificarRut } from '../../core/schemas/actividadesEconomicas';
import { RutaHandler, ejecutar, badRequest } from './comun';

// Las dos rutas de `contribuyentes` que faltaban del catálogo: los códigos de
// actividad económica (página pública del SII) y el verificador de RUT (que es
// aritmética y no toca el SII). Ninguna recibe credencial; siguen pasando por
// el auth de tenant y el rate-limit.
const zodActividades = z.object(schemaActividades);
const zodActividad = z.object(schemaActividad);
const zodVerificarRut = z.object(schemaVerificarRut);

export function registrarRutasActividadesEconomicas(rutas: Map<string, RutaHandler>): void {
  rutas.set('POST /v1/contribuyentes/actividades-economicas', async body => {
    const p = zodActividades.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { categoria, afecta_iva, texto } = p.data;
    return ejecutar(() => core.actividades({ categoria, afectaIva: afecta_iva, texto }));
  });

  rutas.set('POST /v1/contribuyentes/actividad-economica', async body => {
    const p = zodActividad.safeParse(body);
    if (!p.success) return badRequest(p.error);
    return ejecutar(() => core.actividad(p.data.codigo));
  });

  rutas.set('POST /v1/contribuyentes/verificar-rut', async body => {
    const p = zodVerificarRut.safeParse(body);
    if (!p.success) return badRequest(p.error);
    return ejecutar(async () => core.verificarRut(p.data.rut));
  });
}
