import * as http from 'http';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { clasificarErrorCredenciales } from './erroresSesion';
import { compararApiKey } from './apiKey';
import { leerBody, responderJson, BodyDemasiadoGrande } from './rest/http';

export type ResultadoValidacion =
  | { ok: true }
  | { ok: false; error: 'CREDENCIALES_INVALIDAS' | 'ERROR' };

// Valida una clave tributaria contra el SII real, de una sola pasada: autentica,
// confirma el resultado y cierra todo antes de devolver la respuesta — a
// diferencia de sii_iniciar_sesion, no deja nada operable.
//
// authenticateOnly() y logout() corren en el MISMO turno de la cola por RUT
// (dentro del mismo registro.ejecutar), con try/finally. Un logout() como una
// llamada a registro.ejecutar aparte quedaría encolado detrás de cualquier
// operación que haya entrado para ese RUT mientras tanto — ver la sección
// "Timeout" del spec.
//
// logout() va en su propio try/catch que descarta el error: si lanzara sin
// atajarlo, la semántica de `finally` en JS pisaría el resultado de
// authenticateOnly() — una clave CORRECTA terminaría reportada como ERROR
// sólo porque el logout posterior falló (red, sesión ya cerrada, etc). El
// propósito de este endpoint es clasificar la clave, no el logout.
export async function validarClave(
  rut: string,
  clave: string,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): Promise<ResultadoValidacion> {
  credenciales.guardar(rut, clave);
  try {
    await registro.ejecutar(rut, async sesion => {
      try {
        await sesion.authenticateOnly();
      } finally {
        try {
          await sesion.logout();
        } catch {
          // No contamina el resultado de authenticateOnly (ver comentario arriba).
        }
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: clasificarErrorCredenciales(e) };
  } finally {
    // registro.olvidar(rut) es imprescindible acá: sin él, una segunda
    // llamada a este endpoint para el MISMO rut con una clave DISTINTA
    // reusaría la sesión ya autenticada (cacheada hasta 2h) sin volver a
    // autenticar — validaría como correcta una clave que nunca se comprobó.
    registro.olvidar(rut);
    credenciales.borrar(rut);
  }
}

// Servidor HTTP mínimo, sin framework: un solo endpoint. Cada request abre y
// cierra su propia sesión SII (ver validarClave) — no hay estado entre
// requests más que lo que ya vive en `registro`/`credenciales`.
export function crearServidorHttp(
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime,
  apiKey: string
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/validar-clave') {
      res.writeHead(404).end();
      return;
    }

    const authHeader = req.headers.authorization;
    const recibida = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : '';

    if (!compararApiKey(recibida, apiKey)) {
      responderJson(res, 401, { error: 'UNAUTHORIZED' });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await leerBody(req));
    } catch (e) {
      if (e instanceof BodyDemasiadoGrande) {
        responderJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      responderJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }

    const { rut, clave } = (body ?? {}) as { rut?: unknown; clave?: unknown };
    if (typeof rut !== 'string' || typeof clave !== 'string') {
      responderJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }

    const resultado = await validarClave(rut, clave, registro, credenciales);
    responderJson(res, 200, resultado);
  });

  // Sin esto, una conexión que manda headers/body a paso de tortuga (slowloris)
  // queda colgada indefinidamente en vez de cortarse.
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;

  return server;
}
