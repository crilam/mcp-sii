import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/bhe';
import { schemaResumen, schemaMes } from '../../core/schemas/bhe';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler } from './rcv';

const zodResumen = z.object(schemaResumen).extend({ clave: z.string().min(1) });
const zodMes = z.object(schemaMes).extend({ clave: z.string().min(1) });

async function ejecutar<R>(fn: () => Promise<R>) {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasBhe(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/bhe/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.resumen(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/bhe/list-emitidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio, mes } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listEmitidas(ejecutor, rut, anio, mes));
  });

  rutas.set('POST /v1/bhe/list-recibidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio, mes } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listRecibidas(ejecutor, rut, anio, mes));
  });
}
