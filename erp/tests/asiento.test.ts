import {
  AsientoInvalido,
  aprobar,
  borradorDeReversion,
  esAprobable,
  revisar,
} from '../src/dominio/asiento';
import { balanceDeComprobacion, saldoDeudor } from '../src/dominio/mayor';
import { borrador, calendario, plan } from './fixtures';

const APROBACION = { numero: 1, aprobadoPor: 'ana', aprobadoEn: '2026-02-01T10:00:00Z' };

function codigosDeProblema(b: ReturnType<typeof borrador>): string[] {
  return revisar(b, plan(), calendario()).map((p) => p.codigo);
}

describe('invariantes del asiento', () => {
  it('acepta un asiento cuadrado en un período abierto', () => {
    expect(esAprobable(borrador(), plan(), calendario())).toBe(true);
  });

  it('rechaza el descuadre e informa la diferencia', () => {
    const problemas = revisar(
      borrador({
        lineas: [
          { cuentaCodigo: '1101', debe: 1000, haber: 0 },
          { cuentaCodigo: '4101', debe: 0, haber: 999 },
        ],
      }),
      plan(),
      calendario(),
    );

    expect(problemas.map((p) => p.codigo)).toContain('descuadre');
    expect(problemas.find((p) => p.codigo === 'descuadre')?.detalle).toContain('diferencia 1');
  });

  it('rechaza el asiento de una sola línea', () => {
    expect(
      codigosDeProblema(borrador({ lineas: [{ cuentaCodigo: '1101', debe: 0, haber: 0 }] })),
    ).toContain('sin-lineas-suficientes');
  });

  it('rechaza la línea que carga y abona a la vez', () => {
    expect(
      codigosDeProblema(
        borrador({
          lineas: [
            { cuentaCodigo: '1101', debe: 1000, haber: 400 },
            { cuentaCodigo: '4101', debe: 0, haber: 600 },
          ],
        }),
      ),
    ).toContain('linea-en-ambas-columnas');
  });

  it('rechaza la línea que no mueve nada', () => {
    expect(
      codigosDeProblema(
        borrador({
          lineas: [
            { cuentaCodigo: '1101', debe: 1000, haber: 0 },
            { cuentaCodigo: '1102', debe: 0, haber: 0 },
            { cuentaCodigo: '4101', debe: 0, haber: 1000 },
          ],
        }),
      ),
    ).toContain('linea-sin-monto');
  });

  it('rechaza los montos con decimales y los negativos', () => {
    expect(
      codigosDeProblema(
        borrador({
          lineas: [
            { cuentaCodigo: '1101', debe: 1000.5, haber: 0 },
            { cuentaCodigo: '4101', debe: 0, haber: -3 },
          ],
        }),
      ).filter((c) => c === 'monto-invalido'),
    ).toHaveLength(2);
  });

  it('no inventa un descuadre encima de un monto inválido', () => {
    // Sumar un monto no numérico daría NaN y un "descuadre" que confunde el
    // diagnóstico real, que es el monto.
    const codigos = codigosDeProblema(
      borrador({
        lineas: [
          { cuentaCodigo: '1101', debe: Number.NaN, haber: 0 },
          { cuentaCodigo: '4101', debe: 0, haber: 1000 },
        ],
      }),
    );
    expect(codigos).toContain('monto-invalido');
    expect(codigos).not.toContain('descuadre');
  });

  it('rechaza la cuenta inexistente, la que no es hoja y la inactiva', () => {
    expect(
      codigosDeProblema(
        borrador({
          lineas: [
            { cuentaCodigo: '9999', debe: 500, haber: 0 },
            { cuentaCodigo: '1', debe: 500, haber: 0 },
            { cuentaCodigo: '1199', debe: 0, haber: 500 },
            { cuentaCodigo: '4101', debe: 0, haber: 500 },
          ],
        }),
      ),
    ).toEqual(expect.arrayContaining(['cuenta-inexistente', 'cuenta-no-hoja', 'cuenta-inactiva']));
  });

  it('rechaza el asiento sin glosa', () => {
    expect(codigosDeProblema(borrador({ glosa: '   ' }))).toContain('glosa-vacia');
  });

  it('devuelve todos los problemas juntos, no sólo el primero', () => {
    const problemas = codigosDeProblema(
      borrador({
        glosa: '',
        lineas: [{ cuentaCodigo: '9999', debe: 1, haber: 0 }],
      }),
    );
    expect(problemas.length).toBeGreaterThan(2);
  });

  it('aprobar lanza con el detalle de todos los problemas', () => {
    expect(() => aprobar(borrador({ glosa: '' }), plan(), calendario(), APROBACION)).toThrow(
      AsientoInvalido,
    );
  });
});

describe('períodos', () => {
  it('rechaza el asiento en un período cerrado', () => {
    expect(codigosDeProblema(borrador({ fecha: '2025-12-20' }))).toContain('periodo-no-disponible');
  });

  it('rechaza el asiento en un período que no está en el calendario', () => {
    expect(codigosDeProblema(borrador({ fecha: '2026-07-20' }))).toContain('periodo-no-disponible');
  });

  it('rechaza una fecha inexistente sin correrla al mes siguiente', () => {
    // Un Date la habría movido al 1 de marzo en silencio.
    expect(codigosDeProblema(borrador({ fecha: '2026-02-30' }))).toContain('fecha-invalida');
  });
});

describe('inmutabilidad', () => {
  it('el asiento aprobado queda congelado, incluidas sus líneas', () => {
    const asiento = aprobar(borrador(), plan(), calendario(), APROBACION);

    expect(() => {
      (asiento as { glosa: string }).glosa = 'otra';
    }).toThrow();
    expect(() => {
      (asiento.lineas as { length: number }).length = 0;
    }).toThrow();
    expect(() => {
      (asiento.lineas[0] as { debe: number }).debe = 99;
    }).toThrow();
  });

  it('la reversión deja el saldo neto en cero y ambos asientos visibles', () => {
    const p = plan();
    const c = calendario();
    const original = aprobar(borrador(), p, c, APROBACION);

    const reverso = aprobar(
      borradorDeReversion(original, 'b-rev', '2026-02-03', 'cuenta equivocada'),
      p,
      c,
      { numero: 2, aprobadoPor: 'ana', aprobadoEn: '2026-02-03T09:00:00Z', revierteNumero: 1 },
    );

    const mayor = [original, reverso];
    expect(saldoDeudor(mayor, '1101')).toBe(0);
    expect(saldoDeudor(mayor, '4101')).toBe(0);
    expect(mayor).toHaveLength(2);
    expect(reverso.revierteNumero).toBe(1);
    expect(reverso.glosa).toContain('Reversión del asiento 1');
    expect(balanceDeComprobacion(mayor, p).cuadra).toBe(true);
  });

  it('la reversión lleva fecha propia, porque el período original puede estar cerrado', () => {
    const original = aprobar(borrador({ fecha: '2026-01-15' }), plan(), calendario(), APROBACION);
    const reverso = borradorDeReversion(original, 'b-rev', '2026-02-03', 'motivo');
    expect(reverso.fecha).toBe('2026-02-03');
  });
});
