import { getPool } from '../src/db';

describe('getPool', () => {
  const ORIGINAL_ENV = process.env.DATABASE_URL;
  afterEach(() => { process.env.DATABASE_URL = ORIGINAL_ENV; });

  it('lanza si DATABASE_URL no está configurada', () => {
    delete process.env.DATABASE_URL;
    expect(() => getPool()).toThrow('DATABASE_URL');
  });

  it('devuelve siempre la misma instancia de Pool (singleton)', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
  });
});
