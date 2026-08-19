import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/renta';
import { schemaEstadoDeclaracion, schemaF22 } from '../../core/schemas/renta';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler } from './rcv';

const zodEstadoDeclaracion = z.object(schemaEstadoDeclaracion).extend({ clave: z.string().min(1) });
const zodF22 = z.object(schemaF22).extend({ clave: z.string().min(1) });

async function ejecutar<R>(fn: () => Promise<R>) {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasRenta(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/renta/estado-declaracion', async body => {
    const parseo = zodEstadoDeclaracion.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.estadoDeclaracion(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/renta/f22', async body => {
    const parseo = zodF22.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio, folio } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.f22Completo(ejecutor, rut, anio, folio));
  });
}
