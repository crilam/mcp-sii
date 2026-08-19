import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/rcv';
import { schemaResumen, schemaDetalle } from '../../core/schemas/rcv';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';

export interface RespuestaRuta {
  status: number;
  body: unknown;
}

export type RutaHandler = (body: unknown) => Promise<RespuestaRuta>;

// .min(1): una clave vacía nunca es válida contra el SII — rechazarla acá
// evita gastar cupo del rate-limit del tenant en un request condenado a
// fallar antes de siquiera intentar autenticar.
const zodResumen = z.object(schemaResumen).extend({ clave: z.string().min(1) });
const zodDetalle = z.object(schemaDetalle).extend({ clave: z.string().min(1) });

// Traduce cualquier resultado de negocio del core al contrato {ok}. Una ruta
// REST nunca debería ver SesionNoIniciada (cada request trae su propia
// `clave`, arma la sesión de cero) — si ocurriera, se trata como ERROR de
// infraestructura, no como el caso de negocio esperado que sí es en MCP.
async function ejecutar<R>(fn: () => Promise<R>): Promise<RespuestaRuta> {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasRcv(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/rcv/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, periodo, operacion, empresa_rut } = parseo.data;

    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.resumen(ejecutor, rut, periodo, operacion, empresa_rut));
  });

  rutas.set('POST /v1/rcv/detalle', async body => {
    const parseo = zodDetalle.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;

    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.detalle(ejecutor, rut, periodo, operacion, tipo_doc, empresa_rut));
  });
}
