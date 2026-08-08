/**
 * Verifica que las invariantes vivan de verdad en la base, y no sólo en el
 * dominio de TypeScript.
 *
 * La duplicación es deliberada: la aplicación las valida para dar mensajes
 * útiles antes de escribir, y la base las valida para que un bug de la
 * aplicación no pueda dejar el libro en un estado imposible. Un test que sólo
 * ejercitara el dominio dejaría la segunda mitad sin verificar.
 *
 * Se salta entero si no hay Postgres disponible, para que la suite siga
 * corriendo en CI sin base. Cuando se salta lo dice: un test que desaparece en
 * silencio se lee igual que uno que pasa.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const BASE = 'erp_nucleo_test';
const ESQUEMA = join(__dirname, '..', 'db', '001-nucleo.sql');

function psql(sql: string, base = BASE): { salida: string; fallo: boolean } {
  try {
    const salida = execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', base, '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { salida, fallo: false };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string };
    return { salida: `${e.stderr ?? ''}${e.stdout ?? ''}`, fallo: true };
  }
}

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
  console.warn('esquema.test.ts: sin Postgres disponible, las invariantes de la base no se verificaron');
}

describir('invariantes del esquema', () => {
  beforeAll(() => {
    execFileSync('dropdb', ['--if-exists', BASE], { stdio: 'ignore' });
    execFileSync('createdb', [BASE], { stdio: 'ignore' });
    execFileSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', BASE, '-f', ESQUEMA], {
      stdio: 'ignore',
    });

    psql(`
      INSERT INTO empresa (rut, razon_social, inicio_ejercicio)
        VALUES ('11111111-1', 'Empresa de prueba', '2026-01-01');
      INSERT INTO periodo (empresa_rut, clave) VALUES ('11111111-1', '202601');
      INSERT INTO periodo (empresa_rut, clave, estado, cerrado_en, cerrado_por)
        VALUES ('11111111-1', '202512', 'cerrado', now(), 'prueba');
      INSERT INTO cuenta (empresa_rut, codigo, nombre, tipo, padre_codigo) VALUES
        ('11111111-1', '1',    'Activo',   'activo',  NULL),
        ('11111111-1', '1101', 'Caja',     'activo',  '1'),
        ('11111111-1', '1199', 'De baja',  'activo',  '1'),
        ('11111111-1', '4',    'Ingresos', 'ingreso', NULL),
        ('11111111-1', '4101', 'Ventas',   'ingreso', '4'),
        ('11111111-1', '9001', 'Raiz hoja','activo',  NULL),
        ('11111111-1', '9002', 'Raiz otra','ingreso', NULL);
      UPDATE cuenta SET activa = false WHERE empresa_rut = '11111111-1' AND codigo = '1199';
    `);
  });

  afterAll(() => {
    execFileSync('dropdb', ['--if-exists', BASE], { stdio: 'ignore' });
  });

  /** Inserta un asiento con sus líneas en una transacción. */
  function asiento(numero: number, fecha: string, lineas: string): { salida: string; fallo: boolean } {
    return psql(`
      BEGIN;
      INSERT INTO asiento (empresa_rut, numero, fecha, glosa, origen, aprobado_por)
        VALUES ('11111111-1', ${numero}, '${fecha}', 'Asiento ${numero}', 'manual', 'prueba');
      INSERT INTO linea_asiento (empresa_rut, asiento_numero, numero_linea, cuenta_codigo, debe, haber)
        VALUES ${lineas};
      COMMIT;
    `);
  }

  it('acepta un asiento cuadrado en período abierto', () => {
    const r = asiento(10, '2026-01-15', "('11111111-1',10,1,'1101',119000,0),('11111111-1',10,2,'4101',0,119000)");
    expect(r.fallo).toBe(false);
  });

  it('rechaza un asiento descuadrado al hacer COMMIT', () => {
    const r = asiento(11, '2026-01-15', "('11111111-1',11,1,'1101',1000,0),('11111111-1',11,2,'4101',0,999)");
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/no cuadra.*diferencia 1/s);
  });

  it('rechaza un asiento de una sola línea', () => {
    const r = asiento(12, '2026-01-15', "('11111111-1',12,1,'1101',100,0)");
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/al menos dos líneas/);
  });

  it('rechaza la línea que carga y abona a la vez', () => {
    const r = asiento(13, '2026-01-15', "('11111111-1',13,1,'1101',1000,500)");
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/linea_no_en_ambas_columnas/);
  });

  it('rechaza el movimiento en una cuenta que no es hoja', () => {
    const r = asiento(14, '2026-01-15', "('11111111-1',14,1,'1',1000,0),('11111111-1',14,2,'4101',0,1000)");
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/tiene cuentas hijas/);
  });

  it('rechaza el movimiento en una cuenta inactiva', () => {
    const r = asiento(15, '2026-01-15', "('11111111-1',15,1,'1199',1000,0),('11111111-1',15,2,'4101',0,1000)");
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/está inactiva/);
  });

  it('rechaza el asiento en un período cerrado', () => {
    const r = asiento(16, '2025-12-15', "('11111111-1',16,1,'1101',1000,0),('11111111-1',16,2,'4101',0,1000)");
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/está cerrado/);
  });

  it('rechaza el asiento en un período que no está declarado', () => {
    const r = asiento(17, '2026-07-15', "('11111111-1',17,1,'1101',1000,0),('11111111-1',17,2,'4101',0,1000)");
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/no existe en el calendario/);
  });

  it('rechaza editar y borrar un asiento aprobado', () => {
    const editar = psql("UPDATE asiento SET glosa = 'otra' WHERE empresa_rut = '11111111-1' AND numero = 10");
    const borrar = psql("DELETE FROM asiento WHERE empresa_rut = '11111111-1' AND numero = 10");
    const editarLinea = psql("UPDATE linea_asiento SET debe = 1 WHERE empresa_rut = '11111111-1' AND asiento_numero = 10");

    for (const r of [editar, borrar, editarLinea]) {
      expect(r.fallo).toBe(true);
      expect(r.salida).toMatch(/no se modifican ni se borran/);
    }
  });

  it('rechaza una cuenta hija de tipo distinto al del padre', () => {
    const r = psql(
      "INSERT INTO cuenta (empresa_rut, codigo, nombre, tipo, padre_codigo) VALUES ('11111111-1','1198','Mala','pasivo','1')",
    );
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/es pasivo pero su padre 1 es activo/);
  });

  it('rechaza cambiar el tipo de una cuenta que ya tiene movimientos', () => {
    // La cuenta raíz aísla esta regla del chequeo de coherencia con el padre,
    // que si no se dispara primero y deja esta guarda sin ejercitar.
    const conMovimiento = asiento(
      20,
      '2026-01-20',
      "('11111111-1',20,1,'9001',5000,0),('11111111-1',20,2,'9002',0,5000)",
    );
    expect(conMovimiento.fallo).toBe(false);

    const r = psql("UPDATE cuenta SET tipo = 'gasto' WHERE empresa_rut = '11111111-1' AND codigo = '9001'");
    expect(r.fallo).toBe(true);
    expect(r.salida).toMatch(/ya tiene movimientos/);
  });

  it('permite cambiar el tipo de una cuenta sin movimientos', () => {
    psql(
      "INSERT INTO cuenta (empresa_rut, codigo, nombre, tipo, padre_codigo) VALUES ('11111111-1','9003','Sin movimientos','activo',NULL)",
    );
    const r = psql("UPDATE cuenta SET tipo = 'gasto' WHERE empresa_rut = '11111111-1' AND codigo = '9003'");
    expect(r.fallo).toBe(false);
  });

  it('entrega correlativos sin huecos y no deja rastro de los intentos fallidos', () => {
    const r = psql("SELECT siguiente_numero_de_asiento('11111111-1') AS n");
    expect(r.salida).toMatch(/\b21\b/);
  });

  it('el mayor quedó cuadrado después de todos los rechazos', () => {
    const r = psql(
      "SELECT sum(debe) = sum(haber) AS cuadra FROM linea_asiento WHERE empresa_rut = '11111111-1'",
    );
    expect(r.salida).toMatch(/\bt\b/);
  });
});
