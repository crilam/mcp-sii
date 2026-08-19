import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

const DIR_MIGRACIONES = path.join(__dirname, '..', '..', 'db', 'migraciones');

// Runner mínimo, sin librería: una tabla que registra qué migraciones ya
// corrieron, y aplica en orden las que falten. Alcanza para un puñado de
// archivos SQL versionados a mano — no hace falta Prisma Migrate ni Flyway
// para 5 tablas.
export async function aplicarMigraciones(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      nombre text PRIMARY KEY,
      aplicada_en timestamptz NOT NULL DEFAULT now()
    )
  `);

  const archivos = fs.readdirSync(DIR_MIGRACIONES).filter(f => f.endsWith('.sql')).sort();

  for (const archivo of archivos) {
    const { rows } = await pool.query(
      'SELECT 1 FROM migraciones_aplicadas WHERE nombre = $1',
      [archivo]
    );
    if (rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(DIR_MIGRACIONES, archivo), 'utf-8');
    await pool.query(sql);
    await pool.query('INSERT INTO migraciones_aplicadas (nombre) VALUES ($1)', [archivo]);
  }
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  aplicarMigraciones(pool)
    .then(() => { console.log('Migraciones aplicadas.'); return pool.end(); })
    .catch(err => { console.error(err); process.exit(1); });
}
