import * as http from 'http';
import { Pool } from 'pg';
import { aplicarMigraciones } from '../src/scripts/migrar';
import { crearTenant } from '../src/scripts/crearTenant';
import { crearRestServer } from '../src/restServer';
import { RegistroSesiones } from '../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';

function request(port: number, opts: { path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'POST', path: opts.path, headers: opts.headers },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('restServer', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let server: http.Server;
  let port: number;
  let apiKey: string;

  beforeAll(async () => {
    await aplicarMigraciones(pool);
    ({ apiKey } = await crearTenant(pool, 'test-tenant-restserver', 3));

    const registro = { ejecutar: (_rut: string, fn: any) => fn({}), olvidar: jest.fn() } as unknown as RegistroSesiones<any>;
    const credenciales = new ProveedorCredencialesRuntime();
    server = crearRestServer(pool, registro, credenciales);
    await new Promise<void>(resolve => server.listen(0, () => { port = (server.address() as any).port; resolve(); }));
  });

  afterAll(async () => {
    server.close();
    await pool.query('DELETE FROM auditoria WHERE tenant_id IS NULL OR tenant_id IN (SELECT id FROM tenants WHERE nombre = $1)', ['test-tenant-restserver']);
    await pool.query('DELETE FROM rate_limit_contador WHERE tenant_id IN (SELECT id FROM tenants WHERE nombre = $1)', ['test-tenant-restserver']);
    await pool.query('DELETE FROM api_keys WHERE tenant_id IN (SELECT id FROM tenants WHERE nombre = $1)', ['test-tenant-restserver']);
    await pool.query('DELETE FROM tenants WHERE nombre = $1', ['test-tenant-restserver']);
    await pool.end();
  });

  it('GET /health responde 200', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, r => resolve({ status: r.statusCode ?? 0 })).on('error', reject);
    });
    expect(res.status).toBe(200);
  });

  it('sin Authorization responde 401 y audita', async () => {
    const res = await request(port, { path: '/v1/rcv/resumen', body: '{}' });
    expect(res.status).toBe(401);
    const { rows } = await pool.query('SELECT * FROM auditoria WHERE status = 401 ORDER BY id DESC LIMIT 1');
    expect(rows[0].tenant_id).toBeNull();
  });

  it('con API key válida y body válido responde 200', async () => {
    const res = await request(port, {
      path: '/v1/rcv/resumen',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rut: '11.111.111-1', clave: 'x', periodo: '202607', operacion: 'VENTA' }),
    });
    expect(res.status).toBe(200);
  });

  it('ruta desconocida responde 404', async () => {
    const res = await request(port, {
      path: '/v1/no-existe',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(404);
  });

  it('un request autenticado con éxito NO suma al contador de fallos de auth por IP', async () => {
    // El tenant de este test ya usó parte de su límite propio en tests
    // anteriores (limitePorMinuto=3) — uno más alcanza para probar el punto:
    // que auth_fallida_contador no se toca en el camino de éxito, sin importar
    // cuántos requests buenos entren.
    await request(port, {
      path: '/v1/rcv/resumen',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rut: '11.111.111-1', clave: 'x', periodo: '202607', operacion: 'VENTA' }),
    });

    const { rows } = await pool.query(
      `SELECT contador FROM auth_fallida_contador WHERE ip = $1`,
      ['127.0.0.1']
    );
    // Puede haber una fila de la request SIN auth de un test anterior (401),
    // pero el valor no debe reflejar los requests exitosos también hechos
    // desde la misma IP.
    if (rows.length > 0) {
      expect(rows[0].contador).toBe(1);
    }
  });
});
