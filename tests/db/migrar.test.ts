import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';

describe('aplicarMigraciones', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS auditoria, auth_fallida_contador, rate_limit_contador, api_keys, tenants, migraciones_aplicadas CASCADE');
    await pool.end();
  });

  it('crea las 5 tablas del esquema', async () => {
    await aplicarMigraciones(pool);

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const nombres = rows.map(r => r.table_name).filter((n: string) => n !== 'migraciones_aplicadas').sort();
    expect(nombres).toEqual([
      'api_keys', 'auditoria', 'auth_fallida_contador', 'rate_limit_contador', 'tenants',
    ]);
  });

  it('correr dos veces no falla (idempotente)', async () => {
    await expect(aplicarMigraciones(pool)).resolves.not.toThrow();
  });
});
