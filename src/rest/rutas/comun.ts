import { clasificarErrorCredenciales } from '../../erroresSesion';

export interface RespuestaRuta {
  status: number;
  body: unknown;
}

export type RutaHandler = (body: unknown) => Promise<RespuestaRuta>;

// Traduce cualquier resultado de negocio del core al contrato {ok}. Una ruta
// REST nunca debería ver SesionNoIniciada (cada request trae su propia
// `clave`, arma la sesión de cero) — si ocurriera, se trata como ERROR de
// infraestructura, no como el caso de negocio esperado que sí es en MCP.
//
// Si `resultado` es un array (varios core devuelven listas: BoletaBhe[],
// Empresa[]), NO se spreadea directo — `{ ok: true, ...[a, b] }` produce
// `{ ok: true, "0": a, "1": b }` en JSON, perdiendo la forma de lista. Se
// envuelve bajo `datos` en ese caso; los resultados que ya son objetos siguen
// spreadeándose flat, como venía haciendo cada ruta.
export async function ejecutar<R>(fn: () => Promise<R>): Promise<RespuestaRuta> {
  try {
    const resultado = await fn();
    const cuerpo = Array.isArray(resultado) ? { datos: resultado } : (resultado as object);
    return { status: 200, body: { ok: true, ...cuerpo } };
  } catch (e) {
    const error = clasificarErrorCredenciales(e);
    // Un error que no es rechazo de credenciales es un bug (del scraper, de
    // infraestructura) — sin este log, queda invisible detrás del status 200.
    if (error === 'ERROR') {
      console.error('Error no clasificado en ruta REST:', e instanceof Error ? e.message : e);
    }
    return { status: 200, body: { ok: false, error } };
  }
}
