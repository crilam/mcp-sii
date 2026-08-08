import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';

import {
  type DocumentoIngestado,
  RUT_CONTRAPARTE_EXTRANJERA,
  claveDeIdempotencia,
} from '../src/ingesta/documento';
import { conciliar } from '../src/ingesta/conciliacion';
import { type Regla, reglaPara } from '../src/ingesta/reglas';
import { RepositorioIngesta } from '../src/persistencia/repositorioIngesta';

const BASE = 'erp_ingesta_test';
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
  console.warn('repositorioIngesta.test.ts: sin Postgres disponible, la persistencia no se verificó');
}

function doc(parcial: Partial<DocumentoIngestado> = {}): DocumentoIngestado {
  return {
    empresaRut: EMPRESA,
    operacion: 'compra',
    tipoDocCodigo: 33,
    folio: '500',
    fecha: '2026-01-10',
    contraparteRut: '99999999-9',
    contraparteTipoId: 'rut_chileno',
    contraparteNombre: 'Proveedor Ejemplo SpA',
    montoNeto: 50_000,
    montoExento: 0,
    montoIva: 9_500,
    montoTotal: 59_500,
    ...parcial,
  };
}

describir('repositorio de ingesta', () => {
  let pool: Pool;
  let repo: RepositorioIngesta;

  beforeAll(async () => {
    execFileSync('dropdb', ['--if-exists', BASE], { stdio: 'ignore' });
    execFileSync('createdb', [BASE], { stdio: 'ignore' });
    for (const archivo of ['001-nucleo.sql', '002-ingesta.sql']) {
      execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', BASE, '-f', join(DB, archivo)], {
        stdio: 'ignore',
      });
    }

    pool = new Pool({ database: BASE });
    repo = new RepositorioIngesta(pool);

    await pool.query(
      `INSERT INTO empresa (rut, razon_social, inicio_ejercicio) VALUES ($1,'Prueba','2026-01-01')`,
      [EMPRESA],
    );
  });

  afterAll(async () => {
    await pool?.end();
    execFileSync('dropdb', ['--if-exists', BASE], { stdio: 'ignore' });
  });

  it('guarda un documento y lo devuelve para conciliar', async () => {
    const clave = await repo.guardarDocumento(doc());
    expect(clave).toBe(claveDeIdempotencia(doc()));

    const registrados = await repo.documentosRegistrados(EMPRESA);
    expect(registrados).toHaveLength(1);
    expect(registrados[0]?.montoTotal).toBe(59_500);
  });

  it('reingestar el mismo documento no lo duplica', async () => {
    await repo.guardarDocumento(doc());
    await repo.guardarDocumento(doc());
    expect(await repo.documentosRegistrados(EMPRESA)).toHaveLength(1);
  });

  it('la conciliación contra lo guardado reconoce lo repetido', async () => {
    const r = conciliar([doc()], await repo.documentosRegistrados(EMPRESA));
    expect(r.sinCambios).toHaveLength(1);
    expect(r.nuevos).toHaveLength(0);
  });

  it('actualiza los montos cuando el SII corrige el documento', async () => {
    await repo.guardarDocumento(doc({ montoNeto: 60_000, montoIva: 11_400, montoTotal: 71_400 }));
    const registrados = await repo.documentosRegistrados(EMPRESA);
    expect(registrados[0]?.montoTotal).toBe(71_400);
  });

  it('no fusiona dos extranjeros distintos con el mismo folio', async () => {
    const uno = doc({
      folio: '1',
      contraparteRut: RUT_CONTRAPARTE_EXTRANJERA,
      contraparteTipoId: 'extranjero',
      contraparteNombre: 'Amazon Web Services',
    });
    const otro = { ...uno, contraparteNombre: 'Google Cloud' };

    await repo.guardarDocumento(uno);
    await repo.guardarDocumento(otro);

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM documento_ingestado WHERE empresa_rut = $1 AND folio = '1'`,
      [EMPRESA],
    );
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it('la base rechaza un extranjero sin ningún discriminador', async () => {
    // El dominio ya lo aparta como ambiguo; esto es la segunda barrera.
    await expect(
      pool.query(
        `INSERT INTO documento_ingestado (
           empresa_rut, clave, operacion, tipo_doc_codigo, folio, fecha,
           contraparte_rut, contraparte_tipo_id, contraparte_nombre,
           monto_neto, monto_exento, monto_iva, monto_total)
         VALUES ($1,'clave-mala','compra',33,'9','2026-01-10',
                 '55555555-5','extranjero','', 1,0,0,1)`,
        [EMPRESA],
      ),
    ).rejects.toThrow(/documento_extranjero_distinguible/);
  });

  it('lista los pendientes y los saca de la lista al contabilizarlos', async () => {
    const pendientesAntes = await repo.documentosSinContabilizar(EMPRESA);
    expect(pendientesAntes.length).toBeGreaterThan(0);

    await pool.query(
      `INSERT INTO periodo (empresa_rut, clave) VALUES ($1,'202601')
         ON CONFLICT DO NOTHING`,
      [EMPRESA],
    );
    await pool.query(
      `INSERT INTO cuenta (empresa_rut, codigo, nombre, tipo) VALUES
         ($1,'1101','Caja','activo'), ($1,'4101','Ventas','ingreso')
       ON CONFLICT DO NOTHING`,
      [EMPRESA],
    );
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO asiento (empresa_rut, numero, fecha, glosa, origen, aprobado_por)
         VALUES ($1, 1, '2026-01-10', 'Contabiliza documento', 'regla', 'ana')`,
      [EMPRESA],
    );
    await pool.query(
      `INSERT INTO linea_asiento (empresa_rut, asiento_numero, numero_linea, cuenta_codigo, debe, haber)
         VALUES ($1,1,1,'1101',100,0), ($1,1,2,'4101',0,100)`,
      [EMPRESA],
    );
    await pool.query('COMMIT');

    const clave = claveDeIdempotencia(doc());
    await repo.marcarContabilizado(EMPRESA, clave, 1);

    const pendientesDespues = await repo.documentosSinContabilizar(EMPRESA);
    expect(pendientesDespues.map((p) => p.clave)).not.toContain(clave);

    // Y la conciliación ahora sabe que ya está en el mayor, así que un cambio
    // de montos exige reversión en vez de recontabilizarse solo.
    const registrados = await repo.documentosRegistrados(EMPRESA);
    expect(registrados.find((r) => r.clave === clave)?.asientoNumero).toBe(1);
  });

  it('guarda una regla y la devuelve utilizable por el motor', async () => {
    const regla: Regla = {
      id: 'compra-afecta',
      nombre: 'Compra afecta a IVA',
      prioridad: 10,
      activa: true,
      condicion: { operacion: 'compra', tiposDoc: [33] },
      lineas: [
        { cuenta: '5101', columna: 'debe', monto: 'neto' },
        { cuenta: '1103', columna: 'debe', monto: 'iva' },
        { cuenta: '2101', columna: 'haber', monto: 'total' },
      ],
    };

    await repo.guardarRegla(EMPRESA, regla, 'ana');
    const guardadas = await repo.reglas(EMPRESA);

    expect(guardadas).toHaveLength(1);
    expect(guardadas[0]).toEqual(regla);
    // La prueba que importa: sobrevive el viaje a JSONB y sigue eligiéndose.
    expect(reglaPara(guardadas, doc())?.id).toBe('compra-afecta');
  });

  it('la base rechaza una regla con menos de dos líneas', async () => {
    await expect(
      repo.guardarRegla(
        EMPRESA,
        {
          id: 'incompleta',
          nombre: 'Una sola línea',
          prioridad: 1,
          activa: true,
          condicion: {},
          lineas: [{ cuenta: '5101', columna: 'debe', monto: 'neto' }],
        },
        'ana',
      ),
    ).rejects.toThrow(/regla_tiene_lineas/);
  });

  it('no deja que una empresa vea las reglas de otra', async () => {
    await pool.query(
      `INSERT INTO empresa (rut, razon_social, inicio_ejercicio) VALUES ('22222222-2','Otra','2026-01-01')`,
    );
    expect(await repo.reglas('22222222-2')).toHaveLength(0);
  });
});
