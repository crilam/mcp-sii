import { registerRcvTools } from '../../src/tools/rcv';
import { RcvScraper } from '../../src/scrapers/rcv';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/rcv');

const MockScraper = RcvScraper as jest.MockedClass<typeof RcvScraper>;

function registrar(rutRegistrado?: string) {
  const tools: Record<string, { descripcion: string; schema: any; handler: Function }> = {};
  const server = {
    tool: (nombre: string, descripcion: string, schema: any, handler: Function) => {
      tools[nombre] = { descripcion, schema, handler };
    },
  };
  const registro = {
    ejecutar: (rut: string, fn: any) => {
      if (rutRegistrado !== undefined && rut !== rutRegistrado) {
        return Promise.reject(new Error(`No hay sesión iniciada para el RUT ${rut}. Llamá sii_iniciar_sesion primero.`));
      }
      return fn({});
    },
  } as unknown as RegistroSesiones<any>;
  registerRcvTools(server as any, registro);
  return { tools };
}

describe('registerRcvTools', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 4 tools de rcv', () => {
    const { tools } = registrar();

    expect(Object.keys(tools)).toEqual([
      'sii_rcv_resumen', 'sii_rcv_detalle', 'sii_rcv_empresas_autorizadas',
      'sii_rcv_tipos_documento',
    ]);
  });

  it('exige el rut de la sesión en el schema de las dos tools', () => {
    const { tools } = registrar();

    expect(tools['sii_rcv_resumen'].schema.rut.isOptional()).toBe(false);
    expect(tools['sii_rcv_detalle'].schema.rut.isOptional()).toBe(false);
  });

  it('sin sesión iniciada devuelve SESION_NO_INICIADA', async () => {
    const { tools } = registrar('22.222.222-2');

    const res = await tools['sii_rcv_resumen'].handler({
      rut: '11.111.111-1', periodo: '202607', operacion: 'VENTA',
    });

    expect(JSON.parse(res.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('pasa período, operación y empresa al scraper', async () => {
    (MockScraper.prototype.resumen as jest.Mock).mockResolvedValue({ filas: [] });
    const { tools } = registrar();

    await tools['sii_rcv_resumen'].handler({
      rut: '11.111.111-1', periodo: '202607', operacion: 'VENTA', empresa_rut: '22222222-2',
    });

    expect(MockScraper.prototype.resumen).toHaveBeenCalledWith('202607', 'VENTA', '22222222-2');
  });

  // La empresa es un parámetro de la llamada, no un estado de la sesión.
  it('acepta la consulta sin empresa_rut', async () => {
    (MockScraper.prototype.resumen as jest.Mock).mockResolvedValue({ filas: [] });
    const { tools } = registrar();

    await tools['sii_rcv_resumen'].handler({ rut: '11.111.111-1', periodo: '202607', operacion: 'COMPRA' });

    expect(MockScraper.prototype.resumen).toHaveBeenCalledWith('202607', 'COMPRA', undefined);
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
    (MockScraper.prototype.resumen as jest.Mock).mockResolvedValue({ periodo: '202607', filas: [] });
    const { tools } = registrar();

    const res = await tools['sii_rcv_resumen'].handler({
      rut: '11.111.111-1', periodo: '202607', operacion: 'VENTA',
    });

    expect(JSON.parse(res.content[0].text).periodo).toBe('202607');
  });
});

describe('sii_rcv_detalle', () => {
  afterEach(() => jest.clearAllMocks());

  it('pasa período, operación, tipo de documento y empresa al scraper', async () => {
    (MockScraper.prototype.detalle as jest.Mock).mockResolvedValue({ documentos: [] });
    const { tools } = registrar();

    await tools['sii_rcv_detalle'].handler({
      rut: '11.111.111-1', periodo: '202606', operacion: 'COMPRA', tipo_doc: 61, empresa_rut: '22222222-2',
    });

    expect(MockScraper.prototype.detalle).toHaveBeenCalledWith('202606', 'COMPRA', 61, '22222222-2');
  });

  it('acepta la consulta sin empresa_rut', async () => {
    (MockScraper.prototype.detalle as jest.Mock).mockResolvedValue({ documentos: [] });
    const { tools } = registrar();

    await tools['sii_rcv_detalle'].handler({
      rut: '11.111.111-1', periodo: '202607', operacion: 'VENTA', tipo_doc: 33,
    });

    expect(MockScraper.prototype.detalle).toHaveBeenCalledWith('202607', 'VENTA', 33, undefined);
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

  // La descripción es lo único que ve el modelo: si no dice que el 55555555-5 es
  // genérico, va a tratarlo como si identificara al cliente extranjero y va a
  // agrupar bajo un mismo "cliente" a compradores de países distintos.
  it('advierte en la descripción que en exportaciones el RUT es genérico y dónde está el identificador real', () => {
    const { tools } = registrar();
    const desc = tools['sii_rcv_detalle'].descripcion;

    expect(desc).toMatch(/55555555-5/);
    expect(desc).toMatch(/genérico/i);
    expect(desc).toMatch(/no tiene RUT chileno/i);
    expect(desc).toMatch(/contraparteTipoId/);
    expect(desc).toMatch(/contraparteIdExtranjero/);
    // La nacionalidad es un código numérico, no un nombre de país: si la
    // descripción no lo dice, el modelo va a inventar el país.
    expect(desc).toMatch(/contraparteNacionalidadCodigo/);
    expect(desc).toMatch(/CÓDIGO NUMÉRICO/);
  });

  it('explica que un período sin documentos no es un error', () => {
    const { tools } = registrar();

    expect(tools['sii_rcv_detalle'].descripcion).toMatch(/sinDatos/);
  });

  // Los montos de una nota de crédito llegan positivos y restan del período:
  // sumar los montoTotal de un detalle del tipo 61 da un total silenciosamente
  // mal. Si la descripción no lo dice, el modelo lo va a hacer.
  it('advierte que las notas de crédito vienen positivas pero restan, y manda a totalizar con el resumen', () => {
    const { tools } = registrar();
    const desc = tools['sii_rcv_detalle'].descripcion;

    expect(desc).toMatch(/POSITIVOS/);
    expect(desc).toMatch(/RESTAN/);
    expect(desc).toMatch(/Para\s+totalizar hay que usar sii_rcv_resumen/);
  });

  it('devuelve el detalle como JSON', async () => {
    (MockScraper.prototype.detalle as jest.Mock).mockResolvedValue({ periodo: '202606', documentos: [] });
    const { tools } = registrar();

    const res = await tools['sii_rcv_detalle'].handler({
      rut: '11.111.111-1', periodo: '202606', operacion: 'COMPRA', tipo_doc: 61,
    });

    expect(JSON.parse(res.content[0].text).periodo).toBe('202606');
  });
});
