import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { hashApiKey } from '../../src/rest/apiKeyFormato';

describe('crearTenant', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => { await aplicarMigraciones(pool); });
  afterEach(async () => { await pool.query('DELETE FROM api_keys'); await pool.query('DELETE FROM tenants'); });
  afterAll(async () => { await pool.end(); });

  it('crea el tenant y una api key activa, con el hash correcto en la tabla', async () => {
    const { tenantId, apiKey } = await crearTenant(pool, 'rdte');

    const { rows } = await pool.query(
      'SELECT tenant_id, key_hash, revocada_en FROM api_keys WHERE tenant_id = $1',
      [tenantId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashApiKey(apiKey));
    expect(rows[0].revocada_en).toBeNull();
  });

  it('usa el límite por minuto pasado, o 60 por defecto', async () => {
    const { tenantId } = await crearTenant(pool, 'agenticerp', 120);
    const { rows } = await pool.query('SELECT limite_por_minuto FROM tenants WHERE id = $1', [tenantId]);
    expect(rows[0].limite_por_minuto).toBe(120);
  });
});
