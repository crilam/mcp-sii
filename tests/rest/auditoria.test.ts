import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { registrarAuditoria } from '../../src/rest/auditoria';

describe('registrarAuditoria', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => { await aplicarMigraciones(pool); });
  afterEach(async () => {
    await pool.query('DELETE FROM auditoria');
    await pool.query('DELETE FROM api_keys');
    await pool.query('DELETE FROM tenants');
  });
  afterAll(async () => { await pool.end(); });

  it('inserta una fila con los campos esperados', async () => {
    const { tenantId } = await crearTenant(pool, 'rdte-auditoria');

    await registrarAuditoria(pool, {
      tenantId, ip: '10.0.0.1', rut: '11.111.111-1', ruta: '/v1/rcv/resumen', status: 200, error: null,
    });

    const { rows } = await pool.query('SELECT * FROM auditoria');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: tenantId, rut: '11.111.111-1', ruta: '/v1/rcv/resumen', status: 200, error: null,
    });
  });

  // Ronda 11: la traza de escritura guarda efecto (simulado/ejecutado) y la
  // referencia del acto. Las lecturas los dejan NULL.
  it('persiste efecto y referencia en una escritura', async () => {
    const { tenantId } = await crearTenant(pool, 'rdte-aud-escritura');

    await registrarAuditoria(pool, {
      tenantId, ip: '10.0.0.1', rut: '11.111.111-1', ruta: '/v1/rcv/acuse', status: 200, error: null,
      efecto: 'ejecutado', referencia: 'ERM:33-100',
    });

    const { rows } = await pool.query('SELECT efecto, referencia FROM auditoria');
    expect(rows[0]).toEqual({ efecto: 'ejecutado', referencia: 'ERM:33-100' });
  });

  it('una lectura deja efecto y referencia en NULL', async () => {
    const { tenantId } = await crearTenant(pool, 'rdte-aud-lectura');
    await registrarAuditoria(pool, {
      tenantId, ip: '10.0.0.1', rut: null, ruta: '/v1/rcv/resumen', status: 200, error: null,
    });
    const { rows } = await pool.query('SELECT efecto, referencia FROM auditoria');
    expect(rows[0]).toEqual({ efecto: null, referencia: null });
  });

  it('acepta tenant_id y rut nulos (rechazo de transporte)', async () => {
    await registrarAuditoria(pool, {
      tenantId: null, ip: '10.0.0.1', rut: null, ruta: '/v1/rcv/resumen', status: 401, error: 'UNAUTHORIZED',
    });
    const { rows } = await pool.query('SELECT * FROM auditoria');
    expect(rows[0].tenant_id).toBeNull();
    expect(rows[0].rut).toBeNull();
  });

  it('no lanza si Neon no responde', async () => {
    const poolRoto = new Pool({ connectionString: 'postgres://nadie:nada@localhost:1/no-existe' });
    await expect(registrarAuditoria(poolRoto, {
      tenantId: null, ip: '10.0.0.1', rut: null, ruta: '/x', status: 500, error: 'ERROR',
    })).resolves.toBeUndefined();
    await poolRoto.end();
  });
});
