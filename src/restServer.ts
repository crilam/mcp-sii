import * as http from 'http';
import { Pool } from 'pg';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { autenticarTenant } from './rest/auth';
import { chequearRateLimitTenant, contadorFallosIp, registrarFalloIp } from './rest/rateLimit';
import { registrarAuditoria } from './rest/auditoria';
import { leerBody, responderJson, BodyDemasiadoGrande } from './rest/http';
import { registrarRutasRcv } from './rest/rutas/rcv';
import { RutaHandler } from './rest/rutas/comun';
import { registrarRutasBhe } from './rest/rutas/bhe';
import { registrarRutasRenta } from './rest/rutas/renta';
import { registrarRutasBienesRaices } from './rest/rutas/bienesRaices';
import { registrarRutasDte } from './rest/rutas/dte';
import { registrarRutasMipyme } from './rest/rutas/mipyme';
import { registrarRutasSesion } from './rest/rutas/sesion';
import { registrarRutasContribuyente } from './rest/rutas/situacionTributaria';
import { registrarRutasIndicadores } from './rest/rutas/indicadores';
import { registrarRutasVehiculos } from './rest/rutas/vehiculos';

const LIMITE_AUTH_FALLIDA_POR_IP = 20;

// El despliegue decidido (spec 2026-08-12) pone este proceso detrás de un
// ALB, nunca expuesto directo a Internet. Sin esto, `remoteAddress` sería
// siempre la IP interna del ALB para TODO tráfico: el límite de fallos de
// auth por IP colapsaría a todos los tenants en una sola IP compartida.
//
// Se toma el ÚLTIMO valor de X-Forwarded-For, no el primero. Cada proxy que
// reenvía un request AGREGA su IP de origen al FINAL de la lista existente
// (formato `cliente, proxy1, proxy2`) — el ALB, que es el único hop que puede
// llegar hasta acá, agrega la IP real vista por él como último elemento. Un
// caller malicioso puede mandar su propio X-Forwarded-For de entrada con
// cualquier IP inventada, pero eso sólo le agrega un valor ADELANTE del que
// el ALB va a appendear después — tomar el primero sería confiar en ese
// valor falsificado por el propio cliente, justo lo que este chequeo existe
// para impedir.
function ipDe(req: http.IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  const valor = Array.isArray(forwardedFor) ? forwardedFor[forwardedFor.length - 1] : forwardedFor;
  const partes = valor?.split(',') ?? [];
  const ultimo = partes[partes.length - 1]?.trim();
  return ultimo || req.socket.remoteAddress || '0.0.0.0';
}

export function crearRestServer(
  pool: Pool,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): http.Server {
  const rutas = new Map<string, RutaHandler>();
  registrarRutasRcv(rutas, registro, credenciales);
  registrarRutasBhe(rutas, registro, credenciales);
  registrarRutasRenta(rutas, registro, credenciales);
  registrarRutasBienesRaices(rutas, registro, credenciales);
  registrarRutasDte(rutas, registro, credenciales);
  registrarRutasMipyme(rutas, registro, credenciales);
  registrarRutasSesion(rutas, registro, credenciales);
  // Consulta pública: no recibe `registro`/`credenciales` (sin clave ni sesión).
  registrarRutasContribuyente(rutas);
  // Sin registro ni credenciales: son páginas públicas del SII.
  registrarRutasIndicadores(rutas);
  registrarRutasVehiculos(rutas);

  const server = http.createServer(async (req, res) => {
    try {
      await manejarRequest(req, res, pool, rutas);
    } catch (e) {
      // Red de seguridad: si algo no controlado llega hasta acá (un throw
      // síncrono fuera de los try/catch internos), igual hay que responder
      // — sin esto, el cliente queda colgado hasta el timeout en vez de
      // recibir un 500. Nunca se loguea `req`/`body` completo: podrían traer
      // la clave tributaria del request. Sólo el mensaje del error.
      console.error('Error no controlado en el adaptador REST:', e instanceof Error ? e.message : e);
      if (!res.headersSent) {
        responderJson(res, 500, { error: 'ERROR' });
      }
    }
  });

  // Sin esto, una conexión que manda headers/body a paso de tortuga (slowloris)
  // queda colgada indefinidamente en vez de cortarse. Se perdió sin querer al
  // absorber validar-clave (httpServer.ts sí los tenía) — repuesto acá.
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;

  return server;
}

async function manejarRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pool: Pool,
  rutas: Map<string, RutaHandler>
): Promise<void> {
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
    // El body ya parseó acá arriba, así que sí se puede extraer `rut` (si
    // vino como string) para esta auditoría, igual que en el camino final.
    const rutCrudo = (body as any)?.rut;
    const rut = typeof rutCrudo === 'string' ? rutCrudo : null;
    await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut, ruta, status: 429, error: 'RATE_LIMITED' });
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
}
