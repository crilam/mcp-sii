import * as http from 'http';
import { Pool } from 'pg';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { autenticarTenant } from './rest/auth';
import { chequearRateLimitTenant, chequearRateLimitIp } from './rest/rateLimit';
import { registrarAuditoria } from './rest/auditoria';
import { leerBody, responderJson, BodyDemasiadoGrande } from './rest/http';
import { registrarRutasRcv, RutaHandler } from './rest/rutas/rcv';

const LIMITE_AUTH_FALLIDA_POR_IP = 20;

function ipDe(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? '0.0.0.0';
}

export function crearRestServer(
  pool: Pool,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): http.Server {
  const rutas = new Map<string, RutaHandler>();
  registrarRutasRcv(rutas, registro, credenciales);

  return http.createServer(async (req, res) => {
    const ip = ipDe(req);
    const ruta = `${req.method} ${req.url}`;

    if (req.method === 'GET' && req.url === '/health') {
      try {
        await pool.query('SELECT 1');
        res.writeHead(200).end();
      } catch {
        res.writeHead(503).end();
      }
      return;
    }

    const handler = rutas.get(ruta);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }

    // Límite por IP sobre intentos de auth, antes de resolver tenant: sin
    // esto, probar API keys al voleo no deja rastro ni tiene freno.
    const permitidoPorIp = await chequearRateLimitIp(pool, ip, LIMITE_AUTH_FALLIDA_POR_IP).catch(() => true);
    if (!permitidoPorIp) {
      await registrarAuditoria(pool, { tenantId: null, ip, rut: null, ruta, status: 429, error: 'RATE_LIMITED' });
      responderJson(res, 429, { error: 'RATE_LIMITED' });
      return;
    }

    const authHeader = req.headers.authorization;
    const apiKey = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;

    const tenant = await autenticarTenant(pool, apiKey).catch(() => null);
    if (!tenant) {
      await registrarAuditoria(pool, { tenantId: null, ip, rut: null, ruta, status: 401, error: 'UNAUTHORIZED' });
      responderJson(res, 401, { error: 'UNAUTHORIZED' });
      return;
    }

    const permitidoPorTenant = await chequearRateLimitTenant(pool, tenant.tenantId, tenant.limitePorMinuto)
      .catch(() => true); // fail-open: no tirar el servicio por un problema del contador.
    if (!permitidoPorTenant) {
      await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut: null, ruta, status: 429, error: 'RATE_LIMITED' });
      responderJson(res, 429, { error: 'RATE_LIMITED' });
      return;
    }

    let bodyTexto: string;
    try {
      bodyTexto = await leerBody(req);
    } catch (e) {
      const status = e instanceof BodyDemasiadoGrande ? 413 : 400;
      const error = e instanceof BodyDemasiadoGrande ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
      await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut: null, ruta, status, error });
      responderJson(res, status, { error });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyTexto);
    } catch {
      await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut: null, ruta, status: 400, error: 'BAD_REQUEST' });
      responderJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }

    const { status, body: respBody } = await handler(body);
    const rut = (body as any)?.rut ?? null;
    const error = (respBody as any)?.error ?? null;
    await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut, ruta, status, error });
    responderJson(res, status, respBody);
  });
}
