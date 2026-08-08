/**
 * El ejercicio de prueba es enero solo, con los cuatro asientos de
 * `fixtures.ts`. Resultado esperado: pérdida de 750.000 (ingresos 100.000
 * contra gastos 850.000).
 */
import { CierreImposible, cerrarEjercicio } from '../src/dominio/cierre';
import { aprobar, totalDebe, totalHaber } from '../src/dominio/asiento';
import { balanceDeComprobacion, estadoDeResultados, saldoDeudor } from '../src/dominio/mayor';
import { EMPRESA, asientosDeEnero, calendario, plan } from './fixtures';

const DATOS = {
  empresaRut: EMPRESA,
  fechaCierre: '2026-01-31',
  fechaApertura: '2026-02-01',
  inicioDelEjercicio: '2026-01-01',
  cuentaResultadoAcumulado: '3101',
};

function cerrado() {
  return cerrarEjercicio(asientosDeEnero(), plan(), DATOS);
}

describe('cierre del ejercicio', () => {
  it('informa el resultado con el signo habitual: negativo es pérdida', () => {
    expect(cerrado().resultado).toBe(-750_000);
    expect(cerrado().resultado).toBe(estadoDeResultados(asientosDeEnero(), plan(), {
      desde: '2026-01-01',
      hasta: '2026-01-31',
    }).resultado);
  });

  it('produce un asiento de cierre cuadrado', () => {
    const { cierre } = cerrado();
    expect(totalDebe(cierre.lineas)).toBe(totalHaber(cierre.lineas));
    expect(totalDebe(cierre.lineas)).toBe(850_000);
  });

  it('carga la pérdida contra la cuenta de patrimonio indicada', () => {
    const linea = cerrado().cierre.lineas.find((l) => l.cuentaCodigo === '3101');
    expect(linea?.debe).toBe(750_000);
    expect(linea?.haber).toBe(0);
  });

  it('deja todas las cuentas de resultado en cero', () => {
    const p = plan();
    const c = calendario();
    const { cierre } = cerrado();

    const conCierre = [
      ...asientosDeEnero(),
      aprobar(cierre, p, c, { numero: 99, aprobadoPor: 'ana', aprobadoEn: '2026-02-01T10:00:00Z' }),
    ];

    for (const codigo of ['4101', '5101', '5102']) {
      expect(saldoDeudor(conCierre, codigo)).toBe(0);
    }
    expect(balanceDeComprobacion(conCierre, p).cuadra).toBe(true);
  });

  it('incorpora el resultado al patrimonio', () => {
    const p = plan();
    const { cierre } = cerrado();
    const conCierre = [
      ...asientosDeEnero(),
      aprobar(cierre, p, calendario(), {
        numero: 99,
        aprobadoPor: 'ana',
        aprobadoEn: '2026-02-01T10:00:00Z',
      }),
    ];
    // Deudor 750.000 en una cuenta acreedora por naturaleza: patrimonio negativo
    // por la pérdida, que es lo correcto.
    expect(saldoDeudor(conCierre, '3101')).toBe(750_000);
  });

  it('el asiento de cierre es aprobable con las invariantes normales', () => {
    expect(() =>
      aprobar(cerrado().cierre, plan(), calendario(), {
        numero: 99,
        aprobadoPor: 'ana',
        aprobadoEn: '2026-02-01T10:00:00Z',
      }),
    ).not.toThrow();
  });
});

describe('apertura del ejercicio siguiente', () => {
  it('produce un asiento de apertura cuadrado', () => {
    const { apertura } = cerrado();
    expect(totalDebe(apertura.lineas)).toBe(totalHaber(apertura.lineas));
    expect(totalDebe(apertura.lineas)).toBe(878_500);
  });

  it('traspasa el patrimonio ya con el resultado incorporado', () => {
    // Calcular la apertura sobre el mayor sin el cierre la dejaría descuadrada
    // por exactamente el resultado del ejercicio.
    const linea = cerrado().apertura.lineas.find((l) => l.cuentaCodigo === '3101');
    expect(linea?.debe).toBe(750_000);
  });

  it('no traspasa cuentas de resultado', () => {
    const codigos = cerrado().apertura.lineas.map((l) => l.cuentaCodigo);
    expect(codigos).not.toContain('4101');
    expect(codigos).not.toContain('5101');
    expect(codigos).not.toContain('5102');
  });

  it('no traspasa cuentas de balance que quedaron en cero', () => {
    expect(cerrado().apertura.lineas.map((l) => l.cuentaCodigo)).not.toContain('2101');
  });

  it('conserva el saldo de cada cuenta de balance', () => {
    const porCuenta = new Map(cerrado().apertura.lineas.map((l) => [l.cuentaCodigo, l]));
    expect(porCuenta.get('1101')?.debe).toBe(119_000);
    expect(porCuenta.get('1102')?.haber).toBe(859_500);
    expect(porCuenta.get('1103')?.debe).toBe(9_500);
    expect(porCuenta.get('2102')?.haber).toBe(19_000);
  });

  it('lleva la fecha del ejercicio siguiente y origen de apertura', () => {
    const { apertura } = cerrado();
    expect(apertura.fecha).toBe('2026-02-01');
    expect(apertura.origen).toBe('apertura');
  });
});

describe('cierres que se rechazan', () => {
  it('rechaza una cuenta de destino que no es de patrimonio', () => {
    expect(() =>
      cerrarEjercicio(asientosDeEnero(), plan(), { ...DATOS, cuentaResultadoAcumulado: '1101' }),
    ).toThrow(/es activo; el resultado del ejercicio se traspasa a patrimonio/);
  });

  it('rechaza una cuenta de destino inexistente', () => {
    expect(() =>
      cerrarEjercicio(asientosDeEnero(), plan(), { ...DATOS, cuentaResultadoAcumulado: '9999' }),
    ).toThrow(CierreImposible);
  });

  it('rechaza una cuenta de destino que no es hoja', () => {
    expect(() =>
      cerrarEjercicio(asientosDeEnero(), plan(), { ...DATOS, cuentaResultadoAcumulado: '3' }),
    ).toThrow(/tiene cuentas hijas/);
  });

  it('rechaza una apertura que no es posterior al cierre', () => {
    expect(() =>
      cerrarEjercicio(asientosDeEnero(), plan(), { ...DATOS, fechaApertura: '2026-01-31' }),
    ).toThrow(/no es posterior al cierre/);
  });

  it('rechaza cerrar un ejercicio sin movimientos de resultado', () => {
    expect(() =>
      cerrarEjercicio(asientosDeEnero(), plan(), {
        ...DATOS,
        inicioDelEjercicio: '2026-02-01',
        fechaCierre: '2026-02-28',
        fechaApertura: '2026-03-01',
      }),
    ).toThrow(/no hay nada que cerrar/);
  });
});
