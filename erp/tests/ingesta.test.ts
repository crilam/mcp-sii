import {
  DocumentoAmbiguo,
  DocumentoInvalido,
  type DocumentoIngestado,
  RUT_CONTRAPARTE_EXTRANJERA,
  claveDeIdempotencia,
  descuadreDelDocumento,
  restaDelPeriodo,
  validarDocumento,
} from '../src/ingesta/documento';
import { conciliar } from '../src/ingesta/conciliacion';
import {
  ReglaDefectuosa,
  type Regla,
  contabilizar,
  contabilizarLote,
  reglaPara,
} from '../src/ingesta/reglas';
import { totalDebe, totalHaber } from '../src/dominio/asiento';

const EMPRESA = '11111111-1';

function doc(parcial: Partial<DocumentoIngestado> = {}): DocumentoIngestado {
  return {
    empresaRut: EMPRESA,
    operacion: 'compra',
    tipoDocCodigo: 33,
    folio: '500',
    fecha: '2026-01-10',
    contraparteRut: '99999999-9',
    contraparteNombre: 'Proveedor Ejemplo SpA',
    montoNeto: 50_000,
    montoExento: 0,
    montoIva: 9_500,
    montoTotal: 59_500,
    ...parcial,
  };
}

const REGLA_COMPRA: Regla = {
  id: 'compra-afecta',
  nombre: 'Compra afecta a IVA',
  prioridad: 10,
  activa: true,
  condicion: { operacion: 'compra', tiposDoc: [33, 61] },
  lineas: [
    { cuenta: '5101', columna: 'debe', monto: 'neto' },
    { cuenta: '1103', columna: 'debe', monto: 'iva', glosa: 'IVA crédito fiscal' },
    { cuenta: '2101', columna: 'haber', monto: 'total' },
  ],
};

describe('clave de idempotencia', () => {
  it('identifica un documento por operación, tipo, folio y contraparte', () => {
    expect(claveDeIdempotencia(doc())).toBe('11111111-1|compra|33|500|99999999-9');
  });

  it('distingue el mismo folio en compra y en venta', () => {
    expect(claveDeIdempotencia(doc({ operacion: 'venta' }))).not.toBe(claveDeIdempotencia(doc()));
  });

  it('no fusiona dos extranjeros distintos con el mismo folio', () => {
    // El SII le da a toda contraparte extranjera el mismo RUT genérico. Sin la
    // razón social en la clave, estos dos documentos serían uno solo y se
    // perdería una compra sin que nada lo delate.
    const uno = doc({ contraparteRut: RUT_CONTRAPARTE_EXTRANJERA, contraparteNombre: 'Amazon Web Services' });
    const otro = doc({ contraparteRut: RUT_CONTRAPARTE_EXTRANJERA, contraparteNombre: 'Google Cloud' });

    expect(claveDeIdempotencia(uno)).not.toBe(claveDeIdempotencia(otro));
  });

  it('trata al mismo extranjero como el mismo aunque cambie acentos o espacios', () => {
    const uno = doc({ contraparteRut: RUT_CONTRAPARTE_EXTRANJERA, contraparteNombre: 'Telefónica  España' });
    const otro = doc({ contraparteRut: RUT_CONTRAPARTE_EXTRANJERA, contraparteNombre: 'telefonica españa' });

    expect(claveDeIdempotencia(uno)).toBe(claveDeIdempotencia(otro));
  });

  it('marca ambiguo al extranjero sin razón social en vez de arriesgar la fusión', () => {
    expect(() =>
      claveDeIdempotencia(doc({ contraparteRut: RUT_CONTRAPARTE_EXTRANJERA, contraparteNombre: '  ' })),
    ).toThrow(DocumentoAmbiguo);
  });

  it('no exige razón social a una contraparte con RUT chileno', () => {
    expect(() => claveDeIdempotencia(doc({ contraparteNombre: '' }))).not.toThrow();
  });
});

describe('validación del documento', () => {
  it('acepta un documento bien formado', () => {
    expect(validarDocumento(doc())).toBeDefined();
  });

  it('rechaza montos con decimales y fechas imposibles', () => {
    expect(() => validarDocumento(doc({ montoNeto: 50_000.5 }))).toThrow(DocumentoInvalido);
    expect(() => validarDocumento(doc({ fecha: '2026-02-30' }))).toThrow(DocumentoInvalido);
  });

  it('rechaza folio vacío', () => {
    expect(() => validarDocumento(doc({ folio: '  ' }))).toThrow(/folio viene vacío/);
  });

  it('no rechaza un documento cuyos componentes no suman el total, pero lo informa', () => {
    // El SII entrega documentos así. Forzarlos escondería el problema.
    const descuadrado = doc({ montoTotal: 60_000 });
    expect(() => validarDocumento(descuadrado)).not.toThrow();
    expect(descuadreDelDocumento(descuadrado)).toBe(500);
    expect(descuadreDelDocumento(doc())).toBe(0);
  });

  it('sabe qué tipos restan del período', () => {
    expect(restaDelPeriodo(61)).toBe(true);
    expect(restaDelPeriodo(60)).toBe(true);
    expect(restaDelPeriodo(33)).toBe(false);
  });
});

describe('motor de reglas', () => {
  it('produce un borrador cuadrado', () => {
    const { borrador } = contabilizar(REGLA_COMPRA, doc(), 'b-1');
    expect(totalDebe(borrador.lineas)).toBe(totalHaber(borrador.lineas));
    expect(totalDebe(borrador.lineas)).toBe(59_500);
    expect(borrador.origen).toBe('regla');
    expect(borrador.referencia).toBe('33-500');
  });

  it('omite las líneas que quedarían en cero', () => {
    // Un documento exento no arrastra una línea de IVA vacía.
    const exento = doc({ montoNeto: 0, montoExento: 50_000, montoIva: 0, montoTotal: 50_000 });
    const regla: Regla = {
      ...REGLA_COMPRA,
      lineas: [
        { cuenta: '5101', columna: 'debe', monto: 'exento' },
        { cuenta: '1103', columna: 'debe', monto: 'iva' },
        { cuenta: '2101', columna: 'haber', monto: 'total' },
      ],
    };
    const { borrador } = contabilizar(regla, exento, 'b-1');
    expect(borrador.lineas).toHaveLength(2);
    expect(borrador.lineas.map((l) => l.cuentaCodigo)).not.toContain('1103');
  });

  it('invierte las columnas en una nota de crédito', () => {
    // Sus montos llegan positivos pero restan del período. Contabilizarla con
    // la misma orientación que la factura duplicaría el efecto en vez de
    // anularlo, y el asiento cuadraría igual.
    const notaCredito = doc({ tipoDocCodigo: 61, folio: '12' });
    const { borrador } = contabilizar(REGLA_COMPRA, notaCredito, 'b-nc');

    const gasto = borrador.lineas.find((l) => l.cuentaCodigo === '5101');
    const proveedor = borrador.lineas.find((l) => l.cuentaCodigo === '2101');

    expect(gasto?.haber).toBe(50_000);
    expect(gasto?.debe).toBe(0);
    expect(proveedor?.debe).toBe(59_500);
  });

  it('la nota de crédito anula exactamente a su factura', () => {
    const factura = contabilizar(REGLA_COMPRA, doc(), 'b-f').borrador;
    const nota = contabilizar(REGLA_COMPRA, doc({ tipoDocCodigo: 61 }), 'b-n').borrador;

    for (const cuenta of ['5101', '1103', '2101']) {
      const neto = [...factura.lineas, ...nota.lineas]
        .filter((l) => l.cuentaCodigo === cuenta)
        .reduce((s, l) => s + l.debe - l.haber, 0);
      expect(neto).toBe(0);
    }
  });

  it('falla nombrando la regla cuando el asiento resultante no cuadra', () => {
    const mala: Regla = {
      ...REGLA_COMPRA,
      nombre: 'Regla mal armada',
      lineas: [
        { cuenta: '5101', columna: 'debe', monto: 'neto' },
        { cuenta: '2101', columna: 'haber', monto: 'total' },
      ],
    };
    expect(() => contabilizar(mala, doc(), 'b-1')).toThrow(ReglaDefectuosa);
    expect(() => contabilizar(mala, doc(), 'b-1')).toThrow(/Regla mal armada.*diferencia -9500/s);
  });

  it('falla si quedó menos de una línea con monto', () => {
    const soloIva: Regla = {
      ...REGLA_COMPRA,
      lineas: [
        { cuenta: '1103', columna: 'debe', monto: 'iva' },
        { cuenta: '2101', columna: 'haber', monto: 'exento' },
      ],
    };
    expect(() => contabilizar(soloIva, doc(), 'b-1')).toThrow(/quedaron 1 líneas con monto/);
  });
});

describe('elección de regla', () => {
  const generica: Regla = { ...REGLA_COMPRA, id: 'generica', condicion: { operacion: 'compra' } };
  const especifica: Regla = {
    ...REGLA_COMPRA,
    id: 'especifica',
    condicion: { operacion: 'compra', contraparteRut: '99999999-9' },
  };

  it('elige la de mayor prioridad', () => {
    const alta = { ...generica, id: 'alta', prioridad: 99 };
    expect(reglaPara([generica, alta], doc())?.id).toBe('alta');
  });

  it('a igual prioridad elige la más específica, no la primera de la lista', () => {
    expect(reglaPara([generica, especifica], doc())?.id).toBe('especifica');
    expect(reglaPara([especifica, generica], doc())?.id).toBe('especifica');
  });

  it('ignora las reglas inactivas', () => {
    expect(reglaPara([{ ...especifica, activa: false }, generica], doc())?.id).toBe('generica');
  });

  it('no devuelve nada si ninguna aplica', () => {
    expect(reglaPara([especifica], doc({ contraparteRut: '88888888-8' }))).toBeUndefined();
  });

  it('respeta el tipo de documento de la condición', () => {
    expect(reglaPara([REGLA_COMPRA], doc({ tipoDocCodigo: 46 }))).toBeUndefined();
  });
});

describe('contabilización de un lote', () => {
  it('no se detiene en el documento que ninguna regla cubre', () => {
    const resultado = contabilizarLote(
      [REGLA_COMPRA],
      [doc({ folio: '1' }), doc({ folio: '2', tipoDocCodigo: 46 }), doc({ folio: '3' })],
      (_d, i) => `b-${i}`,
    );

    expect(resultado.contabilizados).toHaveLength(2);
    expect(resultado.sinRegla).toHaveLength(1);
    expect(resultado.sinRegla[0]?.folio).toBe('2');
  });

  it('separa el problema de la regla del problema del documento', () => {
    const mala: Regla = {
      ...REGLA_COMPRA,
      id: 'mala',
      prioridad: 99,
      lineas: [
        { cuenta: '5101', columna: 'debe', monto: 'neto' },
        { cuenta: '2101', columna: 'haber', monto: 'total' },
      ],
    };
    const resultado = contabilizarLote([mala], [doc()], () => 'b-1');

    expect(resultado.conReglaDefectuosa).toHaveLength(1);
    expect(resultado.sinRegla).toHaveLength(0);
    expect(resultado.conReglaDefectuosa[0]?.error.regla.id).toBe('mala');
  });
});

describe('conciliación al reingestar un período', () => {
  const registrado = {
    clave: claveDeIdempotencia(doc()),
    montoNeto: 50_000,
    montoExento: 0,
    montoIva: 9_500,
    montoTotal: 59_500,
    asientoNumero: 7,
  };

  it('no vuelve a contabilizar lo ya registrado', () => {
    const r = conciliar([doc()], [registrado]);
    expect(r.sinCambios).toHaveLength(1);
    expect(r.nuevos).toHaveLength(0);
  });

  it('reconoce como nuevo lo que no estaba', () => {
    const r = conciliar([doc({ folio: '999' })], [registrado]);
    expect(r.nuevos).toHaveLength(1);
  });

  it('detecta un documento que cambió de monto en vez de saltárselo', () => {
    const r = conciliar([doc({ montoNeto: 60_000, montoTotal: 71_400, montoIva: 11_400 })], [registrado]);

    expect(r.cambiados).toHaveLength(1);
    expect(r.sinCambios).toHaveLength(0);
    expect(r.cambiados[0]?.diferencias).toEqual([
      'neto: estaba 50000, ahora 60000',
      'IVA: estaba 9500, ahora 11400',
      'total: estaba 59500, ahora 71400',
    ]);
    // Ya está en el mayor: corregirlo exige una reversión, y eso no lo decide
    // el motor.
    expect(r.cambiados[0]?.registrado.asientoNumero).toBe(7);
  });

  it('no contabiliza dos veces un repetido dentro del mismo lote', () => {
    const r = conciliar([doc(), doc()], []);
    expect(r.nuevos).toHaveLength(1);
    expect(r.duplicadosEnElLote).toHaveLength(1);
  });

  it('aparta los ambiguos sin frenar el resto del lote', () => {
    const r = conciliar(
      [
        doc({ contraparteRut: RUT_CONTRAPARTE_EXTRANJERA, contraparteNombre: '' }),
        doc({ folio: '777' }),
      ],
      [],
    );

    expect(r.ambiguos).toHaveLength(1);
    expect(r.nuevos).toHaveLength(1);
    expect(r.ambiguos[0]?.motivo).toMatch(/RUT genérico 55555555-5/);
  });
});
