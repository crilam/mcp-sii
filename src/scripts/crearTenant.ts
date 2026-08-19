import { Pool } from 'pg';
import { generarApiKey, hashApiKey } from '../rest/apiKeyFormato';

export async function crearTenant(
  pool: Pool,
  nombre: string,
  limitePorMinuto = 60
): Promise<{ tenantId: string; apiKey: string }> {
  const { rows } = await pool.query(
    'INSERT INTO tenants (nombre, limite_por_minuto) VALUES ($1, $2) RETURNING id',
    [nombre, limitePorMinuto]
  );
  const tenantId = rows[0].id;

  const apiKey = generarApiKey(nombre);
  await pool.query(
    'INSERT INTO api_keys (tenant_id, key_hash) VALUES ($1, $2)',
    [tenantId, hashApiKey(apiKey)]
  );

  return { tenantId, apiKey };
}

if (require.main === module) {
  const nombre = process.argv.find((a, i) => process.argv[i - 1] === '--nombre');
  if (!nombre) {
    console.error('Uso: npm run crear-tenant -- --nombre <nombre>');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  crearTenant(pool, nombre)
    .then(({ tenantId, apiKey }) => {
      console.log(`Tenant creado: ${tenantId}`);
      console.log(`API key (mostrada una sola vez): ${apiKey}`);
      return pool.end();
    })
    .catch(err => { console.error(err); process.exit(1); });
}
