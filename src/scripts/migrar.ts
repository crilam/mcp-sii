import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { getPool } from '../db';

const DIR_MIGRACIONES = path.join(__dirname, '..', '..', 'db', 'migraciones');

// Clave arbitraria fija para el advisory lock de Postgres: sólo importa que
// sea la misma en cada llamada, para serializar corridas concurrentes de
// aplicarMigraciones() contra la misma base (en tests, cada archivo de test
// llama esto en su beforeAll, y Jest los corre en paralelo).
const LOCK_MIGRACIONES = 727_001;

// Runner mínimo, sin librería: una tabla que registra qué migraciones ya
// corrieron, y aplica en orden las que falten. Alcanza para un puñado de
// archivos SQL versionados a mano — no hace falta Prisma Migrate ni Flyway
// para 5 tablas.
export async function aplicarMigraciones(pool: Pool): Promise<void> {
  const cliente = await pool.connect();
  try {
    // pg_advisory_lock bloquea hasta obtener el lock: evita que dos llamadas
    // concurrentes intenten crear las mismas tablas a la vez.
    await cliente.query('SELECT pg_advisory_lock($1)', [LOCK_MIGRACIONES]);

    await cliente.query(`
      CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
        nombre text PRIMARY KEY,
        aplicada_en timestamptz NOT NULL DEFAULT now()
      )
    `);

    const archivos = fs.readdirSync(DIR_MIGRACIONES).filter(f => f.endsWith('.sql')).sort();

    for (const archivo of archivos) {
      const { rows } = await cliente.query(
        'SELECT 1 FROM migraciones_aplicadas WHERE nombre = $1',
        [archivo]
      );
      if (rows.length > 0) continue;

      const sql = fs.readFileSync(path.join(DIR_MIGRACIONES, archivo), 'utf-8');
      // DDL + el INSERT de bookkeeping en una sola transacción: si el DDL
      // corre pero el INSERT falla (o el proceso muere en el medio), sin
      // esto la próxima corrida vuelve a ejecutar el mismo .sql y revienta
      // con "relation already exists" en vez de detectarlo como aplicado.
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migraciones_aplicadas (nombre) VALUES ($1)', [archivo]);
        await cliente.query('COMMIT');
      } catch (e) {
        await cliente.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [LOCK_MIGRACIONES]);
    cliente.release();
  }
}

if (require.main === module) {
  const pool = getPool();
  aplicarMigraciones(pool)
    .then(() => { console.log('Migraciones aplicadas.'); return pool.end(); })
    .catch(err => { console.error(err); process.exit(1); });
}
