/**
 * Integración del repositorio contra Postgres.
 *
 * Se salta con aviso si no hay base. Un test que desaparece en silencio se lee
 * igual que uno que pasa.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';

import { AsientoInvalido, borradorDeReversion } from '../src/dominio/asiento';
import { balanceDeComprobacion } from '../src/dominio/mayor';
import { RepositorioContable, BorradorNoEncontrado } from '../src/persistencia/repositorio';

const BASE = 'erp_repositorio_test';
const ESQUEMA = join(__dirname, '..', 'db', '001-nucleo.sql');
const EMPRESA = '11111111-1';
const OTRA_EMPRESA = '22222222-2';

const ID_VENTA = '00000000-0000-4000-8000-000000000001';
const ID_DESCUADRADO = '00000000-0000-4000-8000-000000000002';
const ID_COMPRA = '00000000-0000-4000-8000-000000000003';
const ID_AJENO = '00000000-0000-4000-8000-000000000004';

function hayPostgres(): boolean {
  try {
    execFileSync('pg_isready', [], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const disponible = hayPostgres();
const describir = disponible ? describe : describe.skip;

if (!disponible) {
  // eslint-disable-next-line no-console
  console.warn('repositorio.test.ts: sin Postgres disponible, la persistencia no se verificó');
}

describir('repositorio contable', () => {
  let pool: Pool;
  let repo: RepositorioContable;

  beforeAll(async () => {
    execFileSync('dropdb', ['--if-exists', BASE], { stdio: 'ignore' });
    execFileSync('createdb', [BASE], { stdio: 'ignore' });
    execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', BASE, '-f', ESQUEMA], {
      stdio: 'ignore',
    });

    pool = new Pool({ database: BASE });
    repo = new RepositorioContable(pool);

    for (const rut of [EMPRESA, OTRA_EMPRESA]) {
      await pool.query(
        `INSERT INTO empresa (rut, razon_social, inicio_ejercicio) VALUES ($1, $2, '2026-01-01')`,
        [rut, `Empresa ${rut}`],
      );
      await pool.query(`INSERT INTO periodo (empresa_rut, clave) VALUES ($1, '202601')`, [rut]);
      await pool.query(
        `INSERT INTO cuenta (empresa_rut, codigo, nombre, tipo, padre_codigo) VALUES
           ($1,'1','Activo','activo',NULL),
           ($1,'1101','Caja','activo','1'),
           ($1,'4','Ingresos','ingreso',NULL),
           ($1,'4101','Ventas','ingreso','4')`,
        [rut],
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    execFileSync('dropdb', ['--if-exists', BASE], { stdio: 'ignore' });
  });

  it('lee el plan de cuentas y distingue las hojas', async () => {
    const plan = await repo.planDeCuentas(EMPRESA);
    expect(plan.esHoja('1101')).toBe(true);
    expect(plan.esHoja('1')).toBe(false);
  });

  it('lee el calendario', async () => {
    expect((await repo.calendario(EMPRESA)).estadoDe('202601')).toBe('abierto');
  });

  it('guarda un borrador y lo devuelve igual', async () => {
    const original = {
      id: ID_VENTA,
      empresaRut: EMPRESA,
      fecha: '2026-01-15',
      glosa: 'Venta al contado',
      origen: 'regla' as const,
      referencia: 'BOL-1',
      lineas: [
        { cuentaCodigo: '1101', debe: 119_000, haber: 0, glosa: 'Efectivo' },
        { cuentaCodigo: '4101', debe: 0, haber: 119_000 },
      ],
    };

    await repo.guardarBorrador(original, 'ana');
    expect(await repo.borrador(EMPRESA, ID_VENTA)).toEqual(original);
  });

  it('no filtra la fecha por zona horaria al ir y volver de la base', async () => {
    // Un Date convertido sin cuidado devolvería 2026-01-14 en Chile.
    expect((await repo.borrador(EMPRESA, ID_VENTA)).fecha).toBe('2026-01-15');
  });

  it('reemplaza las líneas al reguardar, sin dejar las viejas', async () => {
    const borrador = await repo.borrador(EMPRESA, ID_VENTA);
    await repo.guardarBorrador(
      { ...borrador, lineas: [...borrador.lineas, { cuentaCodigo: '1101', debe: 0, haber: 1 }] },
      'ana',
    );
    expect((await repo.borrador(EMPRESA, ID_VENTA)).lineas).toHaveLength(3);

    await repo.guardarBorrador(borrador, 'ana');
    expect((await repo.borrador(EMPRESA, ID_VENTA)).lineas).toHaveLength(2);
  });

  it('aprueba el borrador, lo saca de la bandeja y lo deja en el mayor', async () => {
    const asiento = await repo.aprobarBorrador(EMPRESA, ID_VENTA, 'ana');

    expect(asiento.numero).toBe(1);
    expect(asiento.glosa).toBe('Venta al contado');
    await expect(repo.borrador(EMPRESA, ID_VENTA)).rejects.toThrow(BorradorNoEncontrado);

    const asientos = await repo.asientos(EMPRESA);
    expect(asientos).toHaveLength(1);
    expect(asientos[0]?.lineas).toHaveLength(2);
    expect(asientos[0]?.referencia).toBe('BOL-1');
  });

  it('deja rastro en la auditoría de la propuesta y de la aprobación', async () => {
    const { rows } = await pool.query<{ accion: string; actor: string }>(
      `SELECT accion, actor FROM evento_auditoria WHERE empresa_rut = $1 ORDER BY id`,
      [EMPRESA],
    );
    expect(rows.map((r) => r.accion)).toEqual(
      expect.arrayContaining(['borrador.guardado', 'asiento.aprobado']),
    );
  });

  it('rechaza aprobar un borrador descuadrado y no consume correlativo', async () => {
    await repo.guardarBorrador(
      {
        id: ID_DESCUADRADO,
        empresaRut: EMPRESA,
        fecha: '2026-01-16',
        glosa: 'Descuadrado',
        origen: 'manual',
        lineas: [
          { cuentaCodigo: '1101', debe: 1000, haber: 0 },
          { cuentaCodigo: '4101', debe: 0, haber: 999 },
        ],
      },
      'ana',
    );

    await expect(repo.aprobarBorrador(EMPRESA, ID_DESCUADRADO, 'ana')).rejects.toThrow(
      AsientoInvalido,
    );

    // El borrador sigue en la bandeja para poder corregirlo.
    expect(await repo.borrador(EMPRESA, ID_DESCUADRADO)).toBeDefined();

    // Y el siguiente asiento válido toma el 2: un hueco en la numeración del
    // libro diario es un hallazgo en una fiscalización.
    await repo.guardarBorrador(
      {
        id: ID_COMPRA,
        empresaRut: EMPRESA,
        fecha: '2026-01-17',
        glosa: 'Otra venta',
        origen: 'manual',
        lineas: [
          { cuentaCodigo: '1101', debe: 5000, haber: 0 },
          { cuentaCodigo: '4101', debe: 0, haber: 5000 },
        ],
      },
      'ana',
    );
    expect((await repo.aprobarBorrador(EMPRESA, ID_COMPRA, 'ana')).numero).toBe(2);
  });

  it('descarta un borrador dejando el motivo en la auditoría', async () => {
    await repo.descartarBorrador(EMPRESA, ID_DESCUADRADO, 'ana', 'propuesta equivocada del agente');
    await expect(repo.borrador(EMPRESA, ID_DESCUADRADO)).rejects.toThrow(BorradorNoEncontrado);

    const { rows } = await pool.query<{ detalle: { motivo: string } }>(
      `SELECT detalle FROM evento_auditoria
        WHERE empresa_rut = $1 AND accion = 'borrador.descartado'`,
      [EMPRESA],
    );
    expect(rows[0]?.detalle.motivo).toBe('propuesta equivocada del agente');
  });

  it('registra una reversión que referencia al original', async () => {
    const [original] = await repo.asientos(EMPRESA, { desde: '2026-01-15', hasta: '2026-01-15' });
    const reverso = borradorDeReversion(
      original as NonNullable<typeof original>,
      '00000000-0000-4000-8000-000000000009',
      '2026-01-25',
      'cuenta equivocada',
    );

    await repo.guardarBorrador(reverso, 'ana');
    const asiento = await repo.aprobarBorrador(EMPRESA, reverso.id, 'ana', original?.numero);

    expect(asiento.revierteNumero).toBe(1);

    const plan = await repo.planDeCuentas(EMPRESA);
    const balance = balanceDeComprobacion(await repo.asientos(EMPRESA), plan);
    expect(balance.cuadra).toBe(true);
  });

  it('el mayor leído de la base cuadra', async () => {
    const plan = await repo.planDeCuentas(EMPRESA);
    const balance = balanceDeComprobacion(await repo.asientos(EMPRESA), plan);
    expect(balance.totalDebitos).toBe(balance.totalCreditos);
    expect(balance.cuadra).toBe(true);
  });

  it('no deja que una empresa vea los asientos de otra', async () => {
    await repo.guardarBorrador(
      {
        id: ID_AJENO,
        empresaRut: OTRA_EMPRESA,
        fecha: '2026-01-15',
        glosa: 'Venta de la otra empresa',
        origen: 'manual',
        lineas: [
          { cuentaCodigo: '1101', debe: 777, haber: 0 },
          { cuentaCodigo: '4101', debe: 0, haber: 777 },
        ],
      },
      'beto',
    );
    await repo.aprobarBorrador(OTRA_EMPRESA, ID_AJENO, 'beto');

    const mios = await repo.asientos(EMPRESA);
    const ajenos = await repo.asientos(OTRA_EMPRESA);

    expect(ajenos).toHaveLength(1);
    expect(mios.map((a) => a.glosa)).not.toContain('Venta de la otra empresa');
    // El correlativo es por empresa: la otra empresa arranca en 1 igual.
    expect(ajenos[0]?.numero).toBe(1);
  });

  it('no deja leer un borrador de otra empresa aunque se acierte el id', async () => {
    await expect(repo.borrador(EMPRESA, ID_AJENO)).rejects.toThrow(BorradorNoEncontrado);
  });

  it('rechaza aprobar en un período cerrado', async () => {
    await repo.cerrarPeriodo(EMPRESA, '202601', 'ana');
    expect((await repo.calendario(EMPRESA)).estadoDe('202601')).toBe('cerrado');

    await repo.guardarBorrador(
      {
        id: '00000000-0000-4000-8000-000000000010',
        empresaRut: EMPRESA,
        fecha: '2026-01-28',
        glosa: 'Tarde',
        origen: 'manual',
        lineas: [
          { cuentaCodigo: '1101', debe: 100, haber: 0 },
          { cuentaCodigo: '4101', debe: 0, haber: 100 },
        ],
      },
      'ana',
    );

    await expect(
      repo.aprobarBorrador(EMPRESA, '00000000-0000-4000-8000-000000000010', 'ana'),
    ).rejects.toThrow(AsientoInvalido);
  });
});
