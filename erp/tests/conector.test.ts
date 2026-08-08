/**
 * El conector es la única capa que conoce la forma del RCV. Estas pruebas usan
 * la forma real del scraper (`DetalleRcv`), así que si el SII cambia un campo
 * el compilador lo dice acá y no en producción.
 */
import type { DetalleRcv, FilaDetalleRcv } from '../../src/scrapers/rcv';
import { traducirDetalleRcv } from '../src/ingesta/conector';
import { claveDeIdempotencia } from '../src/ingesta/documento';

function fila(parcial: Partial<FilaDetalleRcv> = {}): FilaDetalleRcv {
  return {
    contraparteRut: '99999999-9',
    contraparteTipoId: 'rut_chileno',
    contraparteIdExtranjero: null,
    contraparteNacionalidadCodigo: null,
    contraparteNombre: 'Proveedor Ejemplo SpA',
    contraparteRol: 'emisor',
    folio: 500,
    fechaEmision: '2026-01-10',
    montoNeto: 50_000,
    montoExento: 0,
    montoIva: 9_500,
    montoTotal: 59_500,
    referenciaTipoDoc: null,
    referenciaFolio: null,
    eventoReceptor: null,
    ...parcial,
  } as FilaDetalleRcv;
}

function detalle(filas: FilaDetalleRcv[]): DetalleRcv {
  return {
    empresaRut: '11111111-1',
    periodo: '202601',
    operacion: 'COMPRA',
    tipoDocCodigo: 33,
    sinDatos: false,
    mensaje: null,
    totalDocumentos: filas.length,
    documentos: filas,
  } as DetalleRcv;
}

describe('traducción del detalle del RCV', () => {
  it('traduce una fila completa', () => {
    const { documentos, noImputables } = traducirDetalleRcv(detalle([fila()]));

    expect(noImputables).toHaveLength(0);
    expect(documentos[0]).toMatchObject({
      operacion: 'compra',
      tipoDocCodigo: 33,
      folio: '500',
      fecha: '2026-01-10',
      contraparteTipoId: 'rut_chileno',
      montoTotal: 59_500,
    });
  });

  it('convierte COMPRA y VENTA a la operación del dominio', () => {
    const venta = { ...detalle([fila()]), operacion: 'VENTA' as const };
    expect(traducirDetalleRcv(venta).documentos[0]?.operacion).toBe('venta');
  });

  it('preserva el tipo de identificación de la contraparte extranjera', () => {
    const { documentos } = traducirDetalleRcv(
      detalle([
        fila({
          contraparteRut: '55555555-5',
          contraparteTipoId: 'extranjero',
          contraparteIdExtranjero: 'VAT-123',
          contraparteNombre: 'Acme Inc',
        }),
      ]),
    );

    // Sin esto, la clave de idempotencia perdería el discriminador y dos
    // proveedores extranjeros con el mismo folio se fusionarían.
    expect(claveDeIdempotencia(documentos[0] as never)).toMatch(/\|id:vat-123$/);
  });

  it('aparta el documento sin fecha en vez de inventarle una', () => {
    // Usar el período de la consulta lo metería en un mes que el SII no afirmó,
    // indistinguible de uno con fecha real.
    const { documentos, noImputables } = traducirDetalleRcv(
      detalle([fila({ fechaEmision: null, folio: 1 }), fila({ folio: 2 })]),
    );

    expect(documentos).toHaveLength(1);
    expect(noImputables).toHaveLength(1);
    expect(noImputables[0]?.motivo).toMatch(/no informó fecha de emisión/);
  });

  it('un documento inválido no frena al resto del período', () => {
    const { documentos, noImputables } = traducirDetalleRcv(
      detalle([fila({ folio: 1, montoNeto: 0.5 }), fila({ folio: 2 }), fila({ folio: 3 })]),
    );

    expect(documentos).toHaveLength(2);
    expect(noImputables).toHaveLength(1);
  });

  it('traslada la referencia de las notas de crédito', () => {
    const { documentos } = traducirDetalleRcv(
      detalle([fila({ referenciaTipoDoc: 33, referenciaFolio: 500 })]),
    );
    expect(documentos[0]?.referenciaTipoDoc).toBe(33);
    expect(documentos[0]?.referenciaFolio).toBe('500');
  });

  it('devuelve vacío sin romperse cuando el período no trae documentos', () => {
    expect(traducirDetalleRcv(detalle([])).documentos).toHaveLength(0);
  });
});
