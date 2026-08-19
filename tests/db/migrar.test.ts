import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';

describe('aplicarMigraciones', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  // No se borran las tablas acá: la base de test es compartida entre todos los
  // archivos de test de infra (Jest corre suites en paralelo), y un DROP en
  // este afterAll competiría con el resto que las necesita viva al mismo tiempo.
  afterAll(async () => {
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
