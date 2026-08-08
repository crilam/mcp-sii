/**
 * Los montos esperados están calculados a mano.
 *
 * Enero: venta neta 100.000 con IVA 19.000; compra neta 50.000 con IVA 9.500.
 * Débito 19.000 contra crédito 9.500 da 9.500 a pagar, sin remanente.
 */
import {
  PeriodoInconsistente,
  RemanenteNoDisponible,
  determinarIva,
  determinarSerie,
  periodoAnterior,
} from '../src/iva/determinacion';
import { CodigosDelF29Faltantes, armarF29, codigosQueFaltan } from '../src/iva/f29';
import { ParametroFaltante, ParametrosInconsistentes, TablaDeParametros } from '../src/parametros/tabla';
import type { DocumentoIngestado } from '../src/ingesta/documento';

const EMPRESA = '11111111-1';

function venta(parcial: Partial<DocumentoIngestado> = {}): DocumentoIngestado {
  return {
    empresaRut: EMPRESA,
    operacion: 'venta',
    tipoDocCodigo: 33,
    folio: '1',
    fecha: '2026-01-15',
    contraparteRut: '99999999-9',
    contraparteTipoId: 'rut_chileno',
    contraparteNombre: 'Cliente SpA',
    montoNeto: 100_000,
    montoExento: 0,
    montoIva: 19_000,
    montoTotal: 119_000,
    ...parcial,
  };
}

function compra(parcial: Partial<DocumentoIngestado> = {}): DocumentoIngestado {
  return venta({ operacion: 'compra', folio: '2', montoNeto: 50_000, montoIva: 9_500, montoTotal: 59_500, ...parcial });
}

describe('determinación del IVA', () => {
  const base = { empresaRut: EMPRESA, periodo: '202601', esPrimerPeriodo: true };

  it('calcula débito y crédito y deja 9.500 a pagar', () => {
    const d = determinarIva({ ...base, documentos: [venta(), compra()] });

    expect(d.debitoFiscal).toBe(19_000);
    expect(d.creditoFiscalDelPeriodo).toBe(9_500);
    expect(d.impuestoAPagar).toBe(9_500);
    expect(d.remanenteParaElSiguiente).toBe(0);
  });

  it('genera remanente cuando el crédito supera al débito', () => {
    const d = determinarIva({ ...base, documentos: [venta(), compra({ montoIva: 30_000 })] });

    expect(d.impuestoAPagar).toBe(0);
    expect(d.remanenteParaElSiguiente).toBe(11_000);
  });

  it('resta las notas de crédito en vez de sumarlas', () => {
    // Sus montos llegan positivos. Sumarlas duplicaría la venta.
    const d = determinarIva({
      ...base,
      documentos: [venta(), venta({ tipoDocCodigo: 61, folio: '9', montoIva: 19_000, montoNeto: 100_000 })],
    });

    expect(d.debitoFiscal).toBe(0);
    expect(d.ventasNetas).toBe(0);
  });

  it('separa ventas exentas del débito', () => {
    const d = determinarIva({
      ...base,
      documentos: [venta({ montoNeto: 0, montoExento: 80_000, montoIva: 0, montoTotal: 80_000 })],
    });

    expect(d.ventasExentas).toBe(80_000);
    expect(d.debitoFiscal).toBe(0);
  });

  it('deja rastro de cada documento que entró', () => {
    const d = determinarIva({ ...base, documentos: [venta(), compra()] });
    expect(d.aportes).toHaveLength(2);
    expect(d.documentosConsiderados).toBe(2);
  });
});

describe('el remanente nunca se asume', () => {
  it('se niega a determinar sin el remanente del período anterior', () => {
    // Asumirlo en cero declararía de más, y el error se arrastraría hacia
    // adelante hasta que alguien cuadre a mano meses después.
    expect(() =>
      determinarIva({ empresaRut: EMPRESA, periodo: '202602', documentos: [venta({ fecha: '2026-02-10' })] }),
    ).toThrow(RemanenteNoDisponible);
  });

  it('nombra el período del que falta el remanente', () => {
    try {
      determinarIva({ empresaRut: EMPRESA, periodo: '202601', documentos: [] });
      throw new Error('debió lanzar');
    } catch (error) {
      expect((error as RemanenteNoDisponible).periodoAnterior).toBe('202512');
    }
  });

  it('acepta cero sólo si se declara primer período', () => {
    expect(() =>
      determinarIva({ empresaRut: EMPRESA, periodo: '202601', documentos: [venta()], esPrimerPeriodo: true }),
    ).not.toThrow();
  });

  it('rechaza declararse primer período trayendo remanente', () => {
    expect(() =>
      determinarIva({
        empresaRut: EMPRESA,
        periodo: '202601',
        documentos: [venta()],
        esPrimerPeriodo: true,
        remanenteAnterior: 5_000,
      }),
    ).toThrow(/no es el primero/);
  });

  it('rechaza un remanente anterior negativo', () => {
    expect(() =>
      determinarIva({ empresaRut: EMPRESA, periodo: '202602', documentos: [], remanenteAnterior: -1 }),
    ).toThrow(/no puede ser negativo/);
  });

  it('usa el remanente anterior para reducir lo que se paga', () => {
    const d = determinarIva({
      empresaRut: EMPRESA,
      periodo: '202602',
      documentos: [venta({ fecha: '2026-02-10' })],
      remanenteAnterior: 15_000,
    });

    expect(d.creditoFiscalTotal).toBe(15_000);
    expect(d.impuestoAPagar).toBe(4_000);
  });

  it('calcula el período anterior cruzando el año', () => {
    expect(periodoAnterior('202601')).toBe('202512');
    expect(periodoAnterior('202603')).toBe('202602');
  });
});

describe('documentos que no corresponden', () => {
  it('rechaza un documento de otro período en vez de ignorarlo', () => {
    // Ignorarlo dejaría mal este período y el suyo.
    expect(() =>
      determinarIva({
        empresaRut: EMPRESA,
        periodo: '202601',
        esPrimerPeriodo: true,
        documentos: [venta(), venta({ folio: '77', fecha: '2026-02-03' })],
      }),
    ).toThrow(PeriodoInconsistente);
  });

  it('rechaza documentos de otra empresa', () => {
    expect(() =>
      determinarIva({
        empresaRut: EMPRESA,
        periodo: '202601',
        esPrimerPeriodo: true,
        documentos: [venta({ empresaRut: '22222222-2' })],
      }),
    ).toThrow(/otra empresa/);
  });
});

describe('serie de períodos encadenados', () => {
  it('arrastra el remanente de un período al siguiente', () => {
    const serie = determinarSerie(
      EMPRESA,
      new Map([
        ['202601', [compra({ montoIva: 30_000 })]],
        ['202602', [venta({ fecha: '2026-02-10' })]],
      ]),
      '202601',
    );

    expect(serie[0]?.remanenteParaElSiguiente).toBe(30_000);
    expect(serie[1]?.remanenteAnterior).toBe(30_000);
    expect(serie[1]?.impuestoAPagar).toBe(0);
    expect(serie[1]?.remanenteParaElSiguiente).toBe(11_000);
  });

  it('detecta un hueco en la serie en vez de perder el remanente', () => {
    expect(() =>
      determinarSerie(
        EMPRESA,
        new Map([
          ['202601', [venta()]],
          ['202603', [venta({ fecha: '2026-03-10' })]],
        ]),
        '202601',
      ),
    ).toThrow(/Falta el período 202602/);
  });
});

describe('tabla de parámetros', () => {
  const tabla = TablaDeParametros.desde([
    {
      nombre: 'f29.codigo.debito_fiscal',
      descripcion: 'Código del débito fiscal',
      unidad: 'codigo',
      valores: [{ desde: '202601', hasta: null, valor: 538, fuente: 'formulario de prueba' }],
    },
  ]);

  it('devuelve el valor vigente', () => {
    expect(tabla.valor('f29.codigo.debito_fiscal', '202603')).toBe(538);
  });

  it('falla nombrando el parámetro y el período cuando no hay valor vigente', () => {
    expect(() => tabla.valor('f29.codigo.debito_fiscal', '202512')).toThrow(ParametroFaltante);
    expect(() => tabla.valor('f29.codigo.debito_fiscal', '202512')).toThrow(/202512/);
  });

  it('no cae al valor de otro período', () => {
    // Es la regla central: un parámetro desactualizado tiene que ser un error
    // ruidoso, no una liquidación silenciosamente incorrecta.
    expect(tabla.tiene('f29.codigo.debito_fiscal', '202512')).toBe(false);
  });

  it('rechaza rangos de vigencia que se solapan', () => {
    expect(() =>
      TablaDeParametros.desde([
        {
          nombre: 'tasa',
          descripcion: 'Una tasa',
          unidad: 'porcentaje',
          valores: [
            { desde: '202601', hasta: null, valor: 19, fuente: 'x' },
            { desde: '202606', hasta: null, valor: 20, fuente: 'x' },
          ],
        },
      ]),
    ).toThrow(/se solapan/);
  });

  it('exige fuente para poder auditar el valor', () => {
    expect(() =>
      TablaDeParametros.desde([
        {
          nombre: 'tasa',
          descripcion: 'Una tasa',
          unidad: 'porcentaje',
          valores: [{ desde: '202601', hasta: null, valor: 19, fuente: '  ' }],
        },
      ]),
    ).toThrow(/sin fuente/);
  });

  it('lista todo lo que falta de una vez, no el primero', () => {
    expect(tabla.faltantes(['a', 'b', 'f29.codigo.debito_fiscal'], '202601')).toEqual(['a', 'b']);
    expect(() => tabla.exigir(['a', 'b'], '202601')).toThrow(ParametrosInconsistentes);
  });
});

describe('armado del F29', () => {
  const determinacion = determinarIva({
    empresaRut: EMPRESA,
    periodo: '202601',
    esPrimerPeriodo: true,
    documentos: [venta(), compra()],
  });

  const sinCodigos = TablaDeParametros.desde([]);

  it('se niega a armar el formulario si los códigos no están cargados', () => {
    // Escribirlos de memoria sería inventar un dato que se ve correcto, y
    // cambian entre versiones del formulario.
    expect(() => armarF29(determinacion, sinCodigos)).toThrow(CodigosDelF29Faltantes);
  });

  it('nombra todos los códigos faltantes juntos', () => {
    expect(codigosQueFaltan('202601', sinCodigos)).toHaveLength(8);
    try {
      armarF29(determinacion, sinCodigos);
      throw new Error('debió lanzar');
    } catch (error) {
      expect((error as CodigosDelF29Faltantes).faltantes).toHaveLength(8);
    }
  });

  it('arma el formulario cuando los códigos están cargados', () => {
    const conCodigos = TablaDeParametros.desde(
      [
        ['f29.codigo.ventas_netas', 1],
        ['f29.codigo.ventas_exentas', 2],
        ['f29.codigo.debito_fiscal', 3],
        ['f29.codigo.compras_netas', 4],
        ['f29.codigo.credito_fiscal', 5],
        ['f29.codigo.remanente_anterior', 6],
        ['f29.codigo.remanente_siguiente', 7],
        ['f29.codigo.impuesto_a_pagar', 8],
      ].map(([nombre, valor]) => ({
        nombre: nombre as string,
        descripcion: 'código de prueba, no del formulario real',
        unidad: 'codigo' as const,
        valores: [{ desde: '202601', hasta: null, valor: valor as number, fuente: 'prueba' }],
      })),
    );

    const f29 = armarF29(determinacion, conCodigos);

    expect(f29.campos).toHaveLength(8);
    expect(f29.campos.find((c) => c.concepto === 'debitoFiscal')?.monto).toBe(19_000);
    expect(f29.campos.find((c) => c.concepto === 'impuestoAPagar')?.monto).toBe(9_500);
    // El sistema arma; presentar lo hace la persona en el portal.
    expect(f29.estado).toBe('armado_sin_presentar');
    expect(f29.determinacion.aportes).toHaveLength(2);
  });

  it('rechaza una tabla que asigna el mismo código a dos conceptos', () => {
    const repetidos = TablaDeParametros.desde(
      [
        'f29.codigo.ventas_netas',
        'f29.codigo.ventas_exentas',
        'f29.codigo.debito_fiscal',
        'f29.codigo.compras_netas',
        'f29.codigo.credito_fiscal',
        'f29.codigo.remanente_anterior',
        'f29.codigo.remanente_siguiente',
        'f29.codigo.impuesto_a_pagar',
      ].map((nombre) => ({
        nombre,
        descripcion: 'código de prueba',
        unidad: 'codigo' as const,
        valores: [{ desde: '202601', hasta: null, valor: 999, fuente: 'prueba' }],
      })),
    );

    expect(() => armarF29(determinacion, repetidos)).toThrow(/mismo código del F29 a más de un concepto/);
  });
});
