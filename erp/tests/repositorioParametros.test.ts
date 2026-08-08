/**
 * Los valores de este archivo son inventados. Lo que se verifica es que la base
 * impida cargar una tabla incoherente, no cuáles son las tasas correctas.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';

import { ParametroFaltante } from '../src/parametros/tabla';
import { RepositorioParametros } from '../src/persistencia/repositorioParametros';

const BASE = 'erp_parametros_test';
const EMPRESA = '11111111-1';
const DB = join(__dirname, '..', 'db');

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
  console.warn('repositorioParametros.test.ts: sin Postgres, la persistencia no se verificó');
}

describir('repositorio de parámetros', () => {
  let pool: Pool;
  let repo: RepositorioParametros;

  beforeAll(async () => {
    execFileSync('dropdb', ['--if-exists', BASE], { stdio: 'ignore' });
    execFileSync('createdb', [BASE], { stdio: 'ignore' });
    for (const archivo of ['001-nucleo.sql', '002-ingesta.sql', '003-parametros.sql']) {
      execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', BASE, '-f', join(DB, archivo)], {
        stdio: 'ignore',
      });
    }

    pool = new Pool({ database: BASE });
    repo = new RepositorioParametros(pool);

    await pool.query(
      `INSERT INTO empresa (rut, razon_social, inicio_ejercicio) VALUES ($1,'Prueba','2026-01-01')`,
      [EMPRESA],
    );
    await pool.query(
      `INSERT INTO cuenta (empresa_rut, codigo, nombre, tipo) VALUES ($1,'5101','Multas','gasto')`,
      [EMPRESA],
    );

    await repo.definirParametro({
      nombre: 'previsional.salud.tasa_legal',
      descripcion: 'Cotización legal de salud',
      unidad: 'porcentaje',
    });
  });

  afterAll(async () => {
    await pool?.end();
    execFileSync('dropdb', ['--if-exists', BASE], { stdio: 'ignore' });
  });

  it('un parámetro declarado sin valores aparece como pendiente de carga', async () => {
    // Es el estado normal de este sistema antes de que alguien cargue las tablas.
    const pendientes = await repo.parametrosSinValores();
    expect(pendientes.map((p) => p.nombre)).toContain('previsional.salud.tasa_legal');
  });

  it('la tabla sin valores hace que el cálculo falle nombrando el parámetro', async () => {
    const tabla = await repo.tablaDeParametros();
    expect(() => tabla.valor('previsional.salud.tasa_legal', '202601')).toThrow(ParametroFaltante);
  });

  it('carga un valor con su vigencia y lo devuelve', async () => {
    await repo.cargarValor(
      'previsional.salud.tasa_legal',
      { desde: '202401', hasta: '202512', valor: 0.07, fuente: 'inventado para pruebas' },
      'ana',
    );

    const tabla = await repo.tablaDeParametros();
    expect(tabla.valor('previsional.salud.tasa_legal', '202406')).toBe(0.07);
    expect(tabla.tiene('previsional.salud.tasa_legal', '202601')).toBe(false);
  });

  it('acepta un rango contiguo que no se solapa', async () => {
    await repo.cargarValor(
      'previsional.salud.tasa_legal',
      { desde: '202601', hasta: null, valor: 0.08, fuente: 'inventado para pruebas' },
      'ana',
    );

    const tabla = await repo.tablaDeParametros();
    expect(tabla.valor('previsional.salud.tasa_legal', '202601')).toBe(0.08);
    expect(tabla.valor('previsional.salud.tasa_legal', '202406')).toBe(0.07);
  });

  it('la base rechaza una vigencia solapada al cargarla', async () => {
    // Detectarlo al cargar y no meses después, cuando un cálculo tome el valor
    // equivocado sin que nada se vea roto.
    await expect(
      repo.cargarValor(
        'previsional.salud.tasa_legal',
        { desde: '202606', hasta: null, valor: 0.09, fuente: 'inventado' },
        'ana',
      ),
    ).rejects.toThrow(/exclusion constraint/);
  });

  it('la base rechaza un valor sin fuente', async () => {
    await expect(
      repo.cargarValor(
        'previsional.salud.tasa_legal',
        { desde: '202301', hasta: '202312', valor: 0.07, fuente: '   ' },
        'ana',
      ),
    ).rejects.toThrow(/parametro_valor_con_fuente/);
  });

  it('la base rechaza un período con mes inválido', async () => {
    await expect(
      repo.cargarValor(
        'previsional.salud.tasa_legal',
        { desde: '202313', hasta: null, valor: 0.07, fuente: 'x' },
        'ana',
      ),
    ).rejects.toThrow(/periodos_validos/);
  });

  it('guarda tramos y los devuelve utilizables', async () => {
    await repo.cargarTramos(
      'impuesto_unico',
      {
        desde: '202601',
        hasta: null,
        unidad: 'utm',
        fuente: 'inventado para pruebas',
        tramos: [
          { desde: 0, hasta: 13.5, factor: 0, rebaja: 0 },
          { desde: 13.5, hasta: null, factor: 0.04, rebaja: 0.54 },
        ],
      },
      'ana',
    );

    const tabla = await repo.tablaDeTramos('impuesto_unico');
    // La prueba que importa: sobrevive el viaje a JSONB y sigue aplicándose.
    expect(tabla.aplicar(20, '202601').impuesto).toBeCloseTo(0.26, 10);
    expect(tabla.tiene('202512')).toBe(false);
  });

  it('la base rechaza una tabla de tramos con vigencia solapada', async () => {
    await expect(
      repo.cargarTramos(
        'impuesto_unico',
        {
          desde: '202606',
          hasta: null,
          unidad: 'utm',
          fuente: 'inventado',
          tramos: [{ desde: 0, hasta: null, factor: 0, rebaja: 0 }],
        },
        'ana',
      ),
    ).rejects.toThrow(/exclusion constraint/);
  });

  it('guarda una liquidación y la devuelve', async () => {
    await repo.guardarLiquidacion(EMPRESA, {
      trabajadorId: 'trabajador-1',
      periodo: '202601',
      totalImponible: 1_000_000,
      totalNoImponible: 0,
      totalHaberes: 1_000_000,
      topeImponibleAfp: 3_600_000,
      imponibleTopadoAfp: 1_000_000,
      cotizaciones: [],
      totalCotizacionesTrabajador: 186_000,
      baseTributable: 814_000,
      baseTributableUtm: 11.63,
      impuestoUnico: 0,
      totalDescuentos: 186_000,
      liquidoAPagar: 814_000,
      aportesDelEmpleador: [],
      costoEmpleador: 1_015_000,
    });

    const guardadas = await repo.liquidacionesDelPeriodo(EMPRESA, '202601');
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]?.liquidoAPagar).toBe(814_000);
  });

  it('la base rechaza una liquidación que no cuadra', async () => {
    // El líquido tiene que ser lo que queda; si no, la liquidación es
    // internamente incoherente y no debe poder guardarse.
    await expect(
      repo.guardarLiquidacion(EMPRESA, {
        trabajadorId: 'trabajador-2',
        periodo: '202601',
        totalImponible: 1_000_000,
        totalNoImponible: 0,
        totalHaberes: 1_000_000,
        topeImponibleAfp: 3_600_000,
        imponibleTopadoAfp: 1_000_000,
        cotizaciones: [],
        totalCotizacionesTrabajador: 186_000,
        baseTributable: 814_000,
        baseTributableUtm: 11.63,
        impuestoUnico: 0,
        totalDescuentos: 186_000,
        liquidoAPagar: 999_999,
        aportesDelEmpleador: [],
        costoEmpleador: 1_015_000,
      }),
    ).rejects.toThrow(/liquidacion_cuadra/);
  });

  it('guarda la clasificación tributaria con su fundamento', async () => {
    await repo.clasificarCuenta(
      EMPRESA,
      { cuentaCodigo: '5101', clasificacion: 'gasto_rechazado', fundamento: 'artículo 33 N°1' },
      'ana',
    );

    const guardadas = await repo.clasificaciones(EMPRESA);
    expect(guardadas[0]?.fundamento).toBe('artículo 33 N°1');
  });

  it('la base rechaza una clasificación sin fundamento', async () => {
    // Sin fundamento la clasificación no se puede defender en una fiscalización.
    await expect(
      repo.clasificarCuenta(
        EMPRESA,
        { cuentaCodigo: '5101', clasificacion: 'gasto_rechazado', fundamento: '  ' },
        'ana',
      ),
    ).rejects.toThrow(/clasificacion_con_fundamento/);
  });

  it('no deja que una empresa vea las clasificaciones de otra', async () => {
    await pool.query(
      `INSERT INTO empresa (rut, razon_social, inicio_ejercicio) VALUES ('22222222-2','Otra','2026-01-01')`,
    );
    expect(await repo.clasificaciones('22222222-2')).toHaveLength(0);
  });
});
