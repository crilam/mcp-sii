import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/rcv';
import { schemaResumen, schemaDetalle } from '../../core/schemas/rcv';
import { clasificarErrorCredenciales } from '../../erroresSesion';

export interface RespuestaRuta {
  status: number;
  body: unknown;
}

export type RutaHandler = (body: unknown) => Promise<RespuestaRuta>;

const zodResumen = z.object(schemaResumen).extend({ clave: z.string() });
const zodDetalle = z.object(schemaDetalle).extend({ clave: z.string() });

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

    // Pass-through: la clave arma la sesión para este request y no se persiste.
    // registro.olvidar(rut) es imprescindible acá: sin él, una sesión ya
    // cacheada de un request anterior con el MISMO rut se reusaría sin volver
    // a autenticar, ignorando esta clave por completo (ver PR #33 review).
    try {
      credenciales.guardar(rut, clave);
      return await ejecutar(() => core.resumen(registro, rut, periodo, operacion, empresa_rut));
    } finally {
      registro.olvidar(rut);
      credenciales.borrar(rut);
    }
  });

  rutas.set('POST /v1/rcv/detalle', async body => {
    const parseo = zodDetalle.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;

    try {
      credenciales.guardar(rut, clave);
      return await ejecutar(() => core.detalle(registro, rut, periodo, operacion, tipo_doc, empresa_rut));
    } finally {
      registro.olvidar(rut);
      credenciales.borrar(rut);
    }
  });
}
