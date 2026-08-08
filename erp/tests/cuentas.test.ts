import { PlanDeCuentas, PlanDeCuentasInvalido, esDeResultado, saldoNatural } from '../src/dominio/cuentas';
import {
  Calendario,
  PeriodoCerrado,
  PeriodoNoRegistrado,
  ReaperturaBloqueada,
  periodoDe,
  validarFecha,
} from '../src/dominio/periodos';
import { CUENTAS, plan } from './fixtures';

describe('plan de cuentas', () => {
  it('distingue hojas de cuentas con hijas', () => {
    expect(plan().esHoja('1101')).toBe(true);
    expect(plan().esHoja('1')).toBe(false);
  });

  it('rechaza códigos duplicados', () => {
    expect(() => PlanDeCuentas.desde([...CUENTAS, CUENTAS[1] as never])).toThrow(
      PlanDeCuentasInvalido,
    );
  });

  it('rechaza un padre inexistente', () => {
    expect(() =>
      PlanDeCuentas.desde([
        { codigo: '7', nombre: 'Huérfana', tipo: 'activo', padreCodigo: '999', activa: true },
      ]),
    ).toThrow(/padre inexistente/);
  });

  it('rechaza una hija de tipo distinto al del padre', () => {
    expect(() =>
      PlanDeCuentas.desde([
        { codigo: '1', nombre: 'Activo', tipo: 'activo', padreCodigo: null, activa: true },
        { codigo: '11', nombre: 'Mala', tipo: 'pasivo', padreCodigo: '1', activa: true },
      ]),
    ).toThrow(/es pasivo pero su padre 1 es activo/);
  });

  it('detecta un ciclo en la jerarquía en vez de colgarse', () => {
    expect(() =>
      PlanDeCuentas.desde([
        { codigo: 'A', nombre: 'A', tipo: 'activo', padreCodigo: 'B', activa: true },
        { codigo: 'B', nombre: 'B', tipo: 'activo', padreCodigo: 'A', activa: true },
      ]),
    ).toThrow(/ciclo/);
  });

  it('junta todos los problemas en un solo error', () => {
    try {
      PlanDeCuentas.desde([
        { codigo: '', nombre: 'Sin código', tipo: 'activo', padreCodigo: null, activa: true },
        { codigo: 'X', nombre: 'Huérfana', tipo: 'activo', padreCodigo: 'nope', activa: true },
      ]);
      throw new Error('debió lanzar');
    } catch (error) {
      expect((error as PlanDeCuentasInvalido).problemas.length).toBe(2);
    }
  });

  it('devuelve la rama completa de una cuenta', () => {
    expect([...plan().ramaDe('1')].map((c) => c.codigo).sort()).toEqual([
      '1',
      '1101',
      '1102',
      '1103',
      '1199',
    ]);
  });

  it('asigna el saldo natural según el tipo', () => {
    expect(saldoNatural('activo')).toBe('deudor');
    expect(saldoNatural('gasto')).toBe('deudor');
    expect(saldoNatural('pasivo')).toBe('acreedor');
    expect(saldoNatural('patrimonio')).toBe('acreedor');
    expect(saldoNatural('ingreso')).toBe('acreedor');
  });

  it('marca como de resultado sólo ingresos y gastos', () => {
    expect(esDeResultado('ingreso')).toBe(true);
    expect(esDeResultado('gasto')).toBe(true);
    expect(esDeResultado('activo')).toBe(false);
  });
});

describe('fechas contables', () => {
  it('rechaza el 30 de febrero en vez de correrlo a marzo', () => {
    expect(() => validarFecha('2026-02-30')).toThrow(/día fuera de rango/);
  });

  it('acepta el 29 de febrero en año bisiesto y lo rechaza si no lo es', () => {
    expect(validarFecha('2024-02-29')).toBe('2024-02-29');
    expect(() => validarFecha('2026-02-29')).toThrow();
  });

  it('rechaza formatos que no sean AAAA-MM-DD', () => {
    expect(() => validarFecha('15/01/2026')).toThrow(/formato/);
    expect(() => validarFecha('2026-1-5')).toThrow(/formato/);
  });

  it('deriva el período sin desplazar por zona horaria', () => {
    // Con Date, el 1 de enero a medianoche UTC cae en diciembre en Chile.
    expect(periodoDe('2026-01-01')).toBe('202601');
    expect(periodoDe('2026-12-31')).toBe('202612');
  });
});

describe('calendario de períodos', () => {
  const base = new Calendario([
    { clave: '202601', estado: 'abierto' },
    { clave: '202602', estado: 'abierto' },
  ]);

  it('exige que el período exista antes de aceptar una fecha', () => {
    expect(() => base.exigirAbiertoPara('2026-05-10')).toThrow(PeriodoNoRegistrado);
  });

  it('rechaza fechas de un período cerrado', () => {
    expect(() => base.cerrar('202601').exigirAbiertoPara('2026-01-10')).toThrow(PeriodoCerrado);
  });

  it('no muta el calendario original al cerrar', () => {
    base.cerrar('202601');
    expect(base.estadoDe('202601')).toBe('abierto');
  });

  it('bloquea reabrir un período con cierres posteriores', () => {
    const conAmbosCerrados = base.cerrar('202601').cerrar('202602');
    expect(() => conAmbosCerrados.reabrir('202601')).toThrow(ReaperturaBloqueada);
  });

  it('permite reabrir si no hay cierres posteriores', () => {
    const reabierto = base.cerrar('202601').cerrar('202602').reabrir('202602').reabrir('202601');
    expect(reabierto.estadoDe('202601')).toBe('abierto');
  });

  it('nombra los períodos que bloquean la reapertura', () => {
    try {
      base.cerrar('202601').cerrar('202602').reabrir('202601');
      throw new Error('debió lanzar');
    } catch (error) {
      expect((error as ReaperturaBloqueada).cerradosPosteriores).toEqual(['202602']);
    }
  });
});
