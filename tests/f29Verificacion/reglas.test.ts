import { verificar, EntradaVerificacion } from '../../src/f29Verificacion/reglas';
import { condicionIva } from '../../src/f29Verificacion/condicionIva';
import { ResumenRcv, FilaResumenRcv, FilaDetalleRcv } from '../../src/scrapers/rcv';

// Datos ficticios (el repositorio es público). Los montos replican la forma de
// los casos reales: retención total (46) omitida del 520 por la propuesta del
// SII, NC sobre facturas tipo 46 y NC sobre boletas.

function resumen(operacion: 'COMPRA' | 'VENTA', filas: Partial<FilaResumenRcv>[]): ResumenRcv {
  return {
    empresaRut: '11111111-1', periodo: '202601', operacion, sinDatos: filas.length === 0, mensaje: null,
    totalDocumentos: 0, actualizadoAl: null, totalesConfiables: true, tiposDesconocidos: [], advertencias: [],
    totales: { neto: 0, exento: 0, iva: 0, total: 0, ivaUsoComun: 0, ivaNoRecuperable: 0 },
    filas: filas.map(f => ({
      tipoDocCodigo: 0, tipoDocNombre: '', documentos: 0, montoNeto: 0, montoExento: 0, montoIva: 0, montoTotal: 0,
      montoIvaUsoComun: 0, montoIvaNoRecuperable: 0, esNotaCredito: false, tipoDesconocido: false, ...f,
    })),
  } as ResumenRcv;
}

const nc = (montoIva: number, referenciaTipoDoc: number | null): FilaDetalleRcv =>
  ({ montoIva, referenciaTipoDoc, referenciaFolio: 1, folio: 1 } as FilaDetalleRcv);

const compras = resumen('COMPRA', [
  { tipoDocCodigo: 33, documentos: 10, montoIva: 1_000_000 },
  { tipoDocCodigo: 46, documentos: 4, montoIva: 300_000 },
  { tipoDocCodigo: 61, documentos: 3, montoIva: 60_000 },
]);
const ncCompras = [nc(10_000, 33), nc(40_000, 46), nc(10_000, 39)];
const ventasAfectas = resumen('VENTA', [{ tipoDocCodigo: 33, documentos: 50, montoNeto: 10_000_000, montoIva: 1_900_000 }]);

function entrada(casilleros: Record<string, number>, extra: Partial<EntradaVerificacion> = {}): EntradaVerificacion {
  return { periodo: 202601, fuente: 'F29', casilleros, compras, ventas: ventasAfectas, ncCompras, ...extra };
}

// Un F29 bien declarado para los datos de arriba.
const correcto = {
  '502': 1_900_000, '503': 50, '510': 0, '509': 0, '538': 1_900_000,
  '519': 14, '520': 1_300_000, '527': 2, '528': 50_000, '537': 1_250_000,
  '089': 650_000, '039': 300_000, '736': 40_000, '596': 260_000, '595': 650_000, '547': 910_000,
};

describe('f29Verificacion/reglas', () => {
  const h = (r: ReturnType<typeof verificar>, codigo: string) => r.hallazgos.find(x => x.codigo === codigo);

  it('un F29 bien declarado no tiene errores ni advertencias', () => {
    const r = verificar(entrada(correcto));
    expect(r.hallazgos.filter(x => x.severidad !== 'ok')).toEqual([]);
    expect(r.efectos).toEqual({ creditoOmitido: 0, retencionDeMas: 0, ivaCosto: 0 });
  });

  it('detecta la propuesta del SII: 520 sólo con el IVA de las 33, sin las 46', () => {
    const r = verificar(entrada({ ...correcto, '520': 1_000_000, '519': 10, '528': 10_000, '527': 1, '736': 0, '596': 300_000 }));
    expect(h(r, '520')).toMatchObject({ severidad: 'error', diferencia: -300_000 });
    expect(h(r, '520')!.explicacion).toMatch(/tipo 46/);
    expect(h(r, '528')).toMatchObject({ severidad: 'error', diferencia: -40_000 });
    expect(h(r, '528')!.explicacion).toMatch(/NC emitidas sobre facturas de compra tipo 46/);
    expect(h(r, '736')).toMatchObject({ severidad: 'error', esperado: 40_000 });
    expect(h(r, '596')).toMatchObject({ esperado: 260_000, diferencia: 40_000 });
    // Crédito neto omitido = 300.000 − 40.000; retención de más = la NC sobre 46.
    expect(r.efectos).toMatchObject({ creditoOmitido: 260_000, retencionDeMas: 40_000 });
  });

  it('no rebaja del 528 las NC sobre boletas', () => {
    const r = verificar(entrada({ ...correcto, '528': 60_000 }));
    expect(h(r, '528')).toMatchObject({ severidad: 'error', diferencia: 10_000 });
    expect(h(r, '528')!.explicacion).toMatch(/boletas/);
  });

  it('NC rebajadas del 520 en vez del 528: aviso de forma, sin efecto en el impuesto', () => {
    const r = verificar(entrada({ ...correcto, '520': 1_260_000, '528': 10_000 }));
    expect(h(r, '520')).toMatchObject({ severidad: 'advertencia', diferencia: -40_000 });
    expect(h(r, '528')).toMatchObject({ severidad: 'advertencia', diferencia: -40_000 });
    expect(h(r, '520')!.explicacion).toMatch(/sobre facturas tipo 46/);
    expect(r.efectos.creditoOmitido).toBe(0);
  });

  it('compara 535 con las DIN y 513 con las notas de débito', () => {
    const conDin = resumen('COMPRA', [...compras.filas, { tipoDocCodigo: 914, documentos: 1, montoIva: 77_000 }]);
    const conNd = resumen('VENTA', [...ventasAfectas.filas, { tipoDocCodigo: 56, documentos: 1, montoIva: 5_000 }]);
    const r = verificar(entrada(correcto, { compras: conDin, ventas: conNd }));
    expect(h(r, '535')).toMatchObject({ declarado: 0, esperado: 77_000, severidad: 'error' });
    expect(h(r, '513')).toMatchObject({ declarado: 0, esperado: 5_000, severidad: 'error' });
  });

  it('avisa la aritmética que no cuadra y el IVA postergado', () => {
    const r = verificar(entrada({ ...correcto, '089': 0, '755': 650_000, '537': 1_250_001 }));
    expect(h(r, '537')).toMatchObject({ severidad: 'advertencia', diferencia: 1 });
    expect(h(r, '755')!.explicacion).toMatch(/Rectificar/);
  });

  it('marca un débito atípico frente a los meses anteriores', () => {
    const normal = resumen('VENTA', [{ tipoDocCodigo: 33, montoIva: 400_000 }]);
    const r = verificar(entrada(correcto, { ventasAnteriores: [normal, normal, normal, normal] }));
    expect(r.hallazgos.find(x => x.codigo === '502' && /atípico/.test(x.concepto))).toBeDefined();
  });

  it('en la propuesta no exige los totales (el SII no los propone)', () => {
    const r = verificar(entrada({ '520': 1_300_000, '528': 50_000, '502': 1_900_000 }, { fuente: 'propuesta' }));
    expect(r.hallazgos.some(x => x.fuenteEsperado === 'cálculo' && x.diferencia !== null)).toBe(false);
    expect(h(r, '039')).toMatchObject({ declarado: 0, esperado: 300_000, fuenteDeclarado: 'propuesta' });
  });

  describe('empresa exenta', () => {
    const ventasExentas = resumen('VENTA', [{ tipoDocCodigo: 34, documentos: 5, montoExento: 8_000_000 }]);
    const exenta = {
      '142': 8_000_000, '586': 5, '502': 0, '503': 0, '510': 0, '509': 0, '562': 1_300_000,
      '039': 300_000, '736': 40_000, '596': 260_000, '595': 0, '547': 260_000,
    };

    it('no marca crédito omitido y avisa que el IVA de las tipo 46 es costo', () => {
      const r = verificar(entrada(exenta, { ventas: ventasExentas }));
      expect(r.condicion.condicion).toBe('exenta');
      expect(r.hallazgos.filter(x => x.severidad === 'error')).toEqual([]);
      expect(r.efectos).toEqual({ creditoOmitido: 0, retencionDeMas: 0, ivaCosto: 300_000 });
      expect(r.hallazgos.find(x => x.severidad === 'info' && /costo/.test(x.explicacion))).toBeDefined();
    });

    it('marca error si declara crédito sin tener derecho', () => {
      const r = verificar(entrada({ ...exenta, '520': 1_000_000 }, { ventas: ventasExentas }));
      expect(h(r, '520')).toMatchObject({ severidad: 'error', esperado: 0 });
      expect(h(r, '520')!.explicacion).toMatch(/no tiene derecho/);
      expect(r.efectos.creditoOmitido).toBe(-1_000_000);
    });
  });
});

describe('f29Verificacion/condicionIva', () => {
  it('afecta con exportaciones; mixta con ventas exentas; exenta sin afectas', () => {
    expect(condicionIva(resumen('VENTA', [{ tipoDocCodigo: 33, montoNeto: 10 }, { tipoDocCodigo: 110, montoExento: 5 }]), null).condicion).toBe('afecta');
    const mixta = condicionIva(resumen('VENTA', [{ tipoDocCodigo: 33, montoNeto: 90 }, { tipoDocCodigo: 34, montoExento: 10 }]),
      resumen('COMPRA', [{ tipoDocCodigo: 33, montoIvaUsoComun: 7 }]));
    expect(mixta).toMatchObject({ condicion: 'mixta', proporcionExenta: 0.1, ivaUsoComun: 7 });
    expect(condicionIva(resumen('VENTA', [{ tipoDocCodigo: 34, montoExento: 10 }]), null).condicion).toBe('exenta');
  });

  it('sin ventas decide por las actividades de Mi SII', () => {
    const vacio = resumen('VENTA', []);
    const act = (afectaIva: boolean | null) => ({ codigo: '1', giro: '', categoria: '1', afectaIva, desde: null });
    expect(condicionIva(vacio, null, [act(false)]).condicion).toBe('exenta');
    expect(condicionIva(vacio, null, [act(true), act(false)]).condicion).toBe('mixta');
    expect(condicionIva(vacio, null, [act(true)]).condicion).toBe('afecta');
  });
});
