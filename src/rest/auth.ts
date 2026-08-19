import { Pool } from 'pg';
import { hashApiKey } from './apiKeyFormato';

export interface TenantAutenticado {
  tenantId: string;
  nombre: string;
  limitePorMinuto: number;
}

export async function autenticarTenant(
  pool: Pool,
  apiKey: string | undefined
): Promise<TenantAutenticado | null> {
  if (!apiKey) return null;

  const { rows } = await pool.query(
    `SELECT t.id AS tenant_id, t.nombre, t.limite_por_minuto
     FROM api_keys k
     JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = $1 AND k.revocada_en IS NULL`,
    [hashApiKey(apiKey)]
  );

  if (rows.length === 0) return null;
  return {
    tenantId: rows[0].tenant_id,
    nombre: rows[0].nombre,
    limitePorMinuto: rows[0].limite_por_minuto,
  };
}
