import { Pool } from 'pg';

// Pool chico y perezoso: Neon limita las conexiones directas, así que se usa
// el connection string *pooled* de Neon (PgBouncer del lado de Neon) con un
// pool cliente chico acá — `max` bajo evita agotar el límite de Neon si el
// proceso escala a varias instancias.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Variable de entorno requerida no encontrada: DATABASE_URL');
    }
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}
