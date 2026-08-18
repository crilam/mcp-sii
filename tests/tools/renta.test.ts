import { registerRentaTools } from '../../src/tools/renta';
import { RentaScraper } from '../../src/scrapers/renta';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/renta');

const MockScraper = RentaScraper as jest.MockedClass<typeof RentaScraper>;

function makeServer() {
  const tools: Record<string, { descripcion: string; schema: any; handler: Function }> = {};
  const server = {
    tool: (nombre: string, descripcion: string, schema: any, handler: Function) => {
      tools[nombre] = { descripcion, schema, handler };
    },
  };
  return { server, tools };
}

function registrar(rutRegistrado?: string) {
  const { server, tools } = makeServer();
  const registro = {
    ejecutar: (rut: string, fn: any) => {
      if (rutRegistrado !== undefined && rut !== rutRegistrado) {
        return Promise.reject(new Error(`No hay sesión iniciada para el RUT ${rut}. Llamá sii_iniciar_sesion primero.`));
      }
      return fn({});
    },
  } as unknown as RegistroSesiones<any>;
  registerRentaTools(server as any, registro);
  return { tools };
}

describe('registerRentaTools', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las dos tools de renta', () => {
    const { tools } = registrar();

    expect(Object.keys(tools).sort())
      .toEqual(['sii_renta_estado_declaracion', 'sii_renta_get_f22']);
  });

  // Es una tool de persona natural: no depende de la empresa seleccionada.
  it('describe las tools como colgando de la persona, no de la empresa', () => {
    const { tools } = registrar();

    expect(tools['sii_renta_estado_declaracion'].descripcion).toMatch(/SII_EMPRESA_RUT/);
    expect(tools['sii_renta_get_f22'].descripcion).toMatch(/SII_EMPRESA_RUT/);
  });

  it('exige el rut de la sesión en el schema de las dos tools', () => {
    const { tools } = registrar();

    expect(tools['sii_renta_estado_declaracion'].schema.rut.isOptional()).toBe(false);
    expect(tools['sii_renta_get_f22'].schema.rut.isOptional()).toBe(false);
  });

  it('sin sesión iniciada devuelve SESION_NO_INICIADA', async () => {
    const { tools } = registrar('22.222.222-2');

    const res = await tools['sii_renta_estado_declaracion'].handler({ rut: '11.111.111-1', anio: 2025 });

    expect(JSON.parse(res.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('devuelve el estado de la declaración como JSON', async () => {
    (MockScraper.prototype.estadoDeclaracion as jest.Mock).mockResolvedValue({
      anio: '2025', sinDatos: false, declaraciones: [], glosas: [],
    });
    const { tools } = registrar();

    const res = await tools['sii_renta_estado_declaracion'].handler({ rut: '11.111.111-1', anio: 2025 });

    expect(MockScraper.prototype.estadoDeclaracion).toHaveBeenCalledWith(2025);
    expect(JSON.parse(res.content[0].text).anio).toBe('2025');
  });

  // El folio es opcional y se resuelve solo: la descripción tiene que decirlo,
  // porque es lo único que ve el modelo para decidir si puede omitirlo.
  it('declara el folio como opcional y explica que se resuelve solo', () => {
    const { tools } = registrar();

    expect(tools['sii_renta_get_f22'].schema.folio.isOptional()).toBe(true);
    expect(tools['sii_renta_get_f22'].descripcion).toMatch(/omite el folio/);
  });

  it('pasa el folio al scraper cuando viene, y undefined cuando no', async () => {
    (MockScraper.prototype.f22Completo as jest.Mock).mockResolvedValue({ lineas: [] });
    const { tools } = registrar();

    await tools['sii_renta_get_f22'].handler({ rut: '11.111.111-1', anio: 2025, folio: 900000001 });
    await tools['sii_renta_get_f22'].handler({ rut: '11.111.111-1', anio: 2025 });

    expect((MockScraper.prototype.f22Completo as jest.Mock).mock.calls)
      .toEqual([[2025, 900000001], [2025, undefined]]);
  });
});
