/**
 * Los valores esperados de este archivo están calculados a mano a partir de los
 * cuatro asientos de `fixtures.ts`, no obtenidos corriendo el código.
 *
 * Enero:
 *   Caja            debe 119.000
 *   Banco                          haber 859.500  (59.500 + 800.000)
 *   IVA crédito     debe   9.500
 *   Proveedores     debe  59.500   haber  59.500
 *   IVA débito                     haber  19.000
 *   Ventas                         haber 100.000
 *   Costo de ventas debe  50.000
 *   Remuneraciones  debe 800.000
 *                   --------------------------
 *                    1.038.000     1.038.000
 */
import {
  balanceDeComprobacion,
  balanceGeneral,
  estadoDeResultados,
  mayorDe,
  saldoDeudor,
} from '../src/dominio/mayor';
import { asientosDeEnero, plan } from './fixtures';

const ENERO = { desde: '2026-01-01', hasta: '2026-01-31' };

describe('balance de comprobación de enero', () => {
  const balance = balanceDeComprobacion(asientosDeEnero(), plan(), ENERO);

  it('cuadra', () => {
    expect(balance.cuadra).toBe(true);
  });

  it('totaliza 1.038.000 en cada columna', () => {
    expect(balance.totalDebitos).toBe(1_038_000);
    expect(balance.totalCreditos).toBe(1_038_000);
  });

  it('totaliza 978.500 de saldo en cada naturaleza', () => {
    expect(balance.totalSaldoDeudor).toBe(978_500);
    expect(balance.totalSaldoAcreedor).toBe(978_500);
  });

  it('deja Banco con saldo acreedor de 859.500', () => {
    const banco = balance.filas.find((f) => f.cuentaCodigo === '1102');
    expect(banco?.saldoAcreedor).toBe(859_500);
    expect(banco?.saldoDeudor).toBe(0);
  });

  it('muestra Proveedores con movimientos y saldo cero, en vez de omitirla', () => {
    // Omitir una cuenta que se movió y volvió a cero escondería el movimiento.
    const proveedores = balance.filas.find((f) => f.cuentaCodigo === '2101');
    expect(proveedores?.debitos).toBe(59_500);
    expect(proveedores?.creditos).toBe(59_500);
    expect(proveedores?.saldoDeudor).toBe(0);
    expect(proveedores?.saldoAcreedor).toBe(0);
  });

  it('omite las cuentas sin movimiento', () => {
    expect(balance.filas.map((f) => f.cuentaCodigo)).not.toContain('3101');
  });

  it('sólo incluye cuentas hoja', () => {
    expect(balance.filas.map((f) => f.cuentaCodigo)).not.toContain('1');
  });
});

describe('estado de resultados de enero', () => {
  const estado = estadoDeResultados(asientosDeEnero(), plan(), ENERO);

  it('presenta los montos en el signo natural de cada cuenta', () => {
    expect(estado.totalIngresos).toBe(100_000);
    expect(estado.totalGastos).toBe(850_000);
    expect(estado.ingresos.every((l) => l.monto > 0)).toBe(true);
    expect(estado.gastos.every((l) => l.monto > 0)).toBe(true);
  });

  it('da una pérdida de 750.000', () => {
    expect(estado.resultado).toBe(-750_000);
  });

  it('no incluye cuentas de balance', () => {
    const codigos = [...estado.ingresos, ...estado.gastos].map((l) => l.cuentaCodigo);
    expect(codigos).toEqual(['4101', '5101', '5102']);
  });
});

describe('balance general al 31 de enero', () => {
  const balance = balanceGeneral(asientosDeEnero(), plan(), '2026-01-31', '2026-01-01');

  it('cuadra: activo igual a pasivo más patrimonio', () => {
    expect(balance.cuadra).toBe(true);
    expect(balance.totalActivos).toBe(-731_000);
    expect(balance.totalPasivos + balance.totalPatrimonio).toBe(-731_000);
  });

  it('incorpora el resultado del ejercicio al patrimonio', () => {
    expect(balance.resultadoDelEjercicio).toBe(-750_000);
    expect(balance.totalPatrimonio).toBe(-750_000);
  });

  it('no cuenta dos veces el resultado de ejercicios anteriores', () => {
    // Con el ejercicio empezando en enero de 2027, nada de enero de 2026 entra
    // al resultado, aunque siga apareciendo en los saldos de balance.
    const siguiente = balanceGeneral(asientosDeEnero(), plan(), '2026-01-31', '2027-01-01');
    expect(siguiente.resultadoDelEjercicio).toBe(0);
  });
});

describe('mayor de una cuenta', () => {
  it('lleva saldo corrido y nombra la contrapartida', () => {
    const movimientos = mayorDe(asientosDeEnero(), '1102');

    expect(movimientos.map((m) => m.saldoAcumulado)).toEqual([-59_500, -859_500]);
    expect(movimientos[0]?.contrapartida).toEqual(['2101']);
    expect(movimientos[1]?.contrapartida).toEqual(['5102']);
  });

  it('respeta el rango de fechas', () => {
    expect(mayorDe(asientosDeEnero(), '1102', { hasta: '2026-01-25' })).toHaveLength(1);
  });
});

describe('saldo por cuenta', () => {
  it('es deudor positivo aunque la cuenta sea de naturaleza acreedora', () => {
    // La interpretación del signo es de los reportes; acá no se interpreta.
    expect(saldoDeudor(asientosDeEnero(), '4101')).toBe(-100_000);
    expect(saldoDeudor(asientosDeEnero(), '1101')).toBe(119_000);
  });
});
