import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { autenticarTenant } from '../../src/rest/auth';
import { hashApiKey } from '../../src/rest/apiKeyFormato';

describe('autenticarTenant', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => { await aplicarMigraciones(pool); });
  afterEach(async () => { await pool.query('DELETE FROM api_keys'); await pool.query('DELETE FROM tenants'); });
  afterAll(async () => { await pool.end(); });

  it('resuelve el tenant con una key válida', async () => {
    const { tenantId, apiKey } = await crearTenant(pool, 'rdte');
    const resultado = await autenticarTenant(pool, apiKey);
    expect(resultado).toMatchObject({ tenantId, nombre: 'rdte' });
  });

  it('null con key inexistente', async () => {
    expect(await autenticarTenant(pool, 'sk_nada_x')).toBeNull();
  });

  it('null sin key', async () => {
    expect(await autenticarTenant(pool, undefined)).toBeNull();
  });

  it('null con key revocada', async () => {
    const { apiKey } = await crearTenant(pool, 'rdte');
    await pool.query(
      `UPDATE api_keys SET revocada_en = now() WHERE key_hash = $1`,
      [hashApiKey(apiKey)]
    );
    expect(await autenticarTenant(pool, apiKey)).toBeNull();
  });
});
