import * as http from 'http';
import { Pool } from 'pg';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { autenticarTenant } from './rest/auth';
import { chequearRateLimitTenant, contadorFallosIp, registrarFalloIp } from './rest/rateLimit';
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

    // Límite por IP sobre FALLOS de auth previos, antes de intentar autenticar
    // de nuevo: sin esto, probar API keys al voleo no tiene freno. Es una
    // lectura, no un incremento — un tenant legítimo detrás de esta IP nunca
    // suma acá con tráfico bueno (ver registrarFalloIp más abajo).
    const fallosPrevios = await contadorFallosIp(pool, ip).catch(() => 0);
    if (fallosPrevios >= LIMITE_AUTH_FALLIDA_POR_IP) {
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
      await registrarFalloIp(pool, ip).catch(() => {});
      await registrarAuditoria(pool, { tenantId: null, ip, rut: null, ruta, status: 401, error: 'UNAUTHORIZED' });
      responderJson(res, 401, { error: 'UNAUTHORIZED' });
      return;
    }

    // El rate-limit del tenant se chequea DESPUÉS de leer/parsear el body, no
    // antes: un body malformado o demasiado grande nunca llega a tocar el SII
    // (falla acá mismo, en la capa de transporte), así que no debería gastar
    // cupo del tenant. Contarlo igual que un request real penalizaría a un
    // cliente por un typo suyo con el mismo peso que una consulta real al SII.
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

    const permitidoPorTenant = await chequearRateLimitTenant(pool, tenant.tenantId, tenant.limitePorMinuto)
      .catch(() => true); // fail-open: no tirar el servicio por un problema del contador.
    if (!permitidoPorTenant) {
      await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut: null, ruta, status: 429, error: 'RATE_LIMITED' });
      responderJson(res, 429, { error: 'RATE_LIMITED' });
      return;
    }

    const { status, body: respBody } = await handler(body);
    // El body todavía no pasó por el zod de la ruta acá afuera (eso lo hace
    // `handler`) — sólo se audita `rut` si efectivamente vino como string, para
    // no meter en la auditoría lo que un caller mande de basura en ese campo.
    const rutCrudo = (body as any)?.rut;
    const rut = typeof rutCrudo === 'string' ? rutCrudo : null;
    const error = (respBody as any)?.error ?? null;
    await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut, ruta, status, error });
    responderJson(res, status, respBody);
  });
}
