import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { chequearRateLimitTenant, chequearRateLimitIp } from '../../src/rest/rateLimit';

describe('rate limit', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => { await aplicarMigraciones(pool); });
  afterEach(async () => {
    await pool.query('DELETE FROM rate_limit_contador');
    await pool.query('DELETE FROM auth_fallida_contador');
    await pool.query('DELETE FROM api_keys');
    await pool.query('DELETE FROM tenants');
  });
  afterAll(async () => { await pool.end(); });

  it('chequearRateLimitTenant permite hasta el límite y bloquea el siguiente', async () => {
    const { tenantId } = await crearTenant(pool, 'rdte', 2);

    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(true);
    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(true);
    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(false);
  });

  it('chequearRateLimitIp permite hasta el límite y bloquea el siguiente', async () => {
    expect(await chequearRateLimitIp(pool, '10.0.0.1', 2)).toBe(true);
    expect(await chequearRateLimitIp(pool, '10.0.0.1', 2)).toBe(true);
    expect(await chequearRateLimitIp(pool, '10.0.0.1', 2)).toBe(false);
  });

  it('IPs distintas no comparten contador', async () => {
    expect(await chequearRateLimitIp(pool, '10.0.0.1', 1)).toBe(true);
    expect(await chequearRateLimitIp(pool, '10.0.0.2', 1)).toBe(true);
  });
});
