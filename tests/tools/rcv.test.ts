import { registerRcvTools } from '../../src/tools/rcv';
import { RcvScraper } from '../../src/scrapers/rcv';

jest.mock('../../src/scrapers/rcv');

const MockScraper = RcvScraper as jest.MockedClass<typeof RcvScraper>;

function registrar() {
  const tools: Record<string, { descripcion: string; schema: any; handler: Function }> = {};
  const server = {
    tool: (nombre: string, descripcion: string, schema: any, handler: Function) => {
      tools[nombre] = { descripcion, schema, handler };
    },
  };
  const scraper = new MockScraper({} as any, {} as any);
  registerRcvTools(server as any, scraper);
  return { tools, scraper };
}

describe('registerRcvTools', () => {
  it('registra sii_rcv_resumen y sii_rcv_detalle', () => {
    const { tools } = registrar();

    expect(Object.keys(tools)).toEqual(['sii_rcv_resumen', 'sii_rcv_detalle']);
  });

  it('pasa período, operación y empresa al scraper', async () => {
    const { tools, scraper } = registrar();
    (scraper.resumen as jest.Mock).mockResolvedValue({ filas: [] });

    await tools['sii_rcv_resumen'].handler({
      periodo: '202607', operacion: 'VENTA', empresa_rut: '22222222-2',
    });

    expect(scraper.resumen).toHaveBeenCalledWith('202607', 'VENTA', '22222222-2');
  });

  // La empresa es un parámetro de la llamada, no un estado de la sesión.
  it('acepta la consulta sin empresa_rut', async () => {
    const { tools, scraper } = registrar();
    (scraper.resumen as jest.Mock).mockResolvedValue({ filas: [] });

    await tools['sii_rcv_resumen'].handler({ periodo: '202607', operacion: 'COMPRA' });

    expect(scraper.resumen).toHaveBeenCalledWith('202607', 'COMPRA', undefined);
    expect(tools['sii_rcv_resumen'].schema.empresa_rut.isOptional()).toBe(true);
  });

  // La descripción es lo único que ve el modelo: si no dice que las notas de
  // crédito ya vienen restadas, puede volver a sumarlas por su cuenta.
  it('avisa en la descripción que las notas de crédito están restadas', () => {
    const { tools } = registrar();

    expect(tools['sii_rcv_resumen'].descripcion).toMatch(/notas de crédito/i);
    expect(tools['sii_rcv_resumen'].descripcion).toMatch(/RESTADAS/);
  });

  // Un mes sin movimientos no es una falla, y el modelo tiene que saberlo para
  // no reportarlo como error al usuario.
  it('explica que un período sin movimientos no es un error', () => {
    const { tools } = registrar();

    expect(tools['sii_rcv_resumen'].descripcion).toMatch(/sinDatos/);
  });

  // Si el modelo no sabe que puede venir un total no confiable, va a leer las
  // cifras como buenas. La bandera sólo sirve si la descripción la nombra.
  it('avisa en la descripción que los totales pueden venir marcados como no confiables', () => {
    const { tools } = registrar();

    expect(tools['sii_rcv_resumen'].descripcion).toMatch(/totalesConfiables/);
  });

  it('devuelve el resumen como JSON', async () => {
    const { tools, scraper } = registrar();
    (scraper.resumen as jest.Mock).mockResolvedValue({ periodo: '202607', filas: [] });

    const res = await tools['sii_rcv_resumen'].handler({
      periodo: '202607', operacion: 'VENTA',
    });

    expect(JSON.parse(res.content[0].text).periodo).toBe('202607');
  });
});

describe('sii_rcv_detalle', () => {
  it('pasa período, operación, tipo de documento y empresa al scraper', async () => {
    const { tools, scraper } = registrar();
    (scraper.detalle as jest.Mock).mockResolvedValue({ documentos: [] });

    await tools['sii_rcv_detalle'].handler({
      periodo: '202606', operacion: 'COMPRA', tipo_doc: 61, empresa_rut: '22222222-2',
    });

    expect(scraper.detalle).toHaveBeenCalledWith('202606', 'COMPRA', 61, '22222222-2');
  });

  it('acepta la consulta sin empresa_rut', async () => {
    const { tools, scraper } = registrar();
    (scraper.detalle as jest.Mock).mockResolvedValue({ documentos: [] });

    await tools['sii_rcv_detalle'].handler({
      periodo: '202607', operacion: 'VENTA', tipo_doc: 33,
    });

    expect(scraper.detalle).toHaveBeenCalledWith('202607', 'VENTA', 33, undefined);
    expect(tools['sii_rcv_detalle'].schema.empresa_rut.isOptional()).toBe(true);
  });

  // El tipo de documento no es opcional: sin él el modelo va a intentar pedir
  // el detalle del período entero, que el SII no ofrece.
  it('exige el tipo de documento en el schema', () => {
    const { tools } = registrar();

    expect(tools['sii_rcv_detalle'].schema.tipo_doc.isOptional()).toBe(false);
  });

  // La descripción es lo único que ve el modelo para decidir cuándo usarla:
  // tiene que decir que el código es obligatorio y de dónde sale.
  it('explica en la descripción que requiere el tipo de documento y que sale del resumen', () => {
    const { tools } = registrar();
    const desc = tools['sii_rcv_detalle'].descripcion;

    expect(desc).toMatch(/REQUIERE/);
    expect(desc).toMatch(/tipo_doc/);
    expect(desc).toMatch(/sii_rcv_resumen/);
    expect(desc).toMatch(/tipoDocCodigo/);
    // La relación entre las dos tools: primero el resumen, después el detalle.
    expect(desc).toMatch(/NO del período entero/);
  });

  it('explica en la descripción el rol de la contraparte y que es solo lectura', () => {
    const { tools } = registrar();
    const desc = tools['sii_rcv_detalle'].descripcion;

    expect(desc).toMatch(/contraparteRol/);
    expect(desc).toMatch(/COMPRA es el emisor/);
    expect(desc).toMatch(/VENTA es el\s+receptor/);
    expect(desc).toMatch(/solo lectura/);
  });

  it('explica que un período sin documentos no es un error', () => {
    const { tools } = registrar();

    expect(tools['sii_rcv_detalle'].descripcion).toMatch(/sinDatos/);
  });

  it('devuelve el detalle como JSON', async () => {
    const { tools, scraper } = registrar();
    (scraper.detalle as jest.Mock).mockResolvedValue({ periodo: '202606', documentos: [] });

    const res = await tools['sii_rcv_detalle'].handler({
      periodo: '202606', operacion: 'COMPRA', tipo_doc: 61,
    });

    expect(JSON.parse(res.content[0].text).periodo).toBe('202606');
  });
});
