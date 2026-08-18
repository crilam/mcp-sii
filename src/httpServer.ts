import * as http from 'http';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { clasificarErrorCredenciales } from './erroresSesion';
import { compararApiKey } from './apiKey';

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
        await sesion.logout();
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: clasificarErrorCredenciales(e) };
  } finally {
    credenciales.borrar(rut);
  }
}

function leerBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', chunk => { datos += chunk; });
    req.on('end', () => resolve(datos));
    req.on('error', reject);
  });
}

function responderJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Servidor HTTP mínimo, sin framework: un solo endpoint. Cada request abre y
// cierra su propia sesión SII (ver validarClave) — no hay estado entre
// requests más que lo que ya vive en `registro`/`credenciales`.
export function crearServidorHttp(
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime,
  apiKey: string
): http.Server {
  return http.createServer(async (req, res) => {
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
    } catch {
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
}
