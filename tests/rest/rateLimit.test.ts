import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { chequearRateLimitTenant, contadorFallosIp, registrarFalloIp } from '../../src/rest/rateLimit';

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
    const { tenantId } = await crearTenant(pool, 'rdte-ratelimit', 2);

    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(true);
    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(true);
    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(false);
  });

  it('contadorFallosIp empieza en 0 y sube sólo con registrarFalloIp', async () => {
    expect(await contadorFallosIp(pool, '10.0.0.1')).toBe(0);

    await registrarFalloIp(pool, '10.0.0.1');
    expect(await contadorFallosIp(pool, '10.0.0.1')).toBe(1);

    await registrarFalloIp(pool, '10.0.0.1');
    expect(await contadorFallosIp(pool, '10.0.0.1')).toBe(2);
  });

  it('contadorFallosIp es de sólo lectura: no incrementa por leerlo', async () => {
    await registrarFalloIp(pool, '10.0.0.1');
    await contadorFallosIp(pool, '10.0.0.1');
    await contadorFallosIp(pool, '10.0.0.1');
    expect(await contadorFallosIp(pool, '10.0.0.1')).toBe(1);
  });

  it('IPs distintas no comparten contador', async () => {
    await registrarFalloIp(pool, '10.0.0.1');
    expect(await contadorFallosIp(pool, '10.0.0.1')).toBe(1);
    expect(await contadorFallosIp(pool, '10.0.0.2')).toBe(0);
  });
});
