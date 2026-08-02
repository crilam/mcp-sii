import { registerRentaTools } from '../../src/tools/renta';
import { RentaScraper } from '../../src/scrapers/renta';

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

function registrar() {
  const { server, tools } = makeServer();
  const scraper = new MockScraper({} as any, {} as any);
  registerRentaTools(server as any, scraper);
  return { tools, scraper };
}

describe('registerRentaTools', () => {
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

  it('devuelve el estado de la declaración como JSON', async () => {
    const { tools, scraper } = registrar();
    (scraper.estadoDeclaracion as jest.Mock).mockResolvedValue({
      anio: '2025', sinDatos: false, declaraciones: [], glosas: [],
    });

    const res = await tools['sii_renta_estado_declaracion'].handler({ anio: 2025 });

    expect(scraper.estadoDeclaracion).toHaveBeenCalledWith(2025);
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
    const { tools, scraper } = registrar();
    (scraper.f22Completo as jest.Mock).mockResolvedValue({ lineas: [] });

    await tools['sii_renta_get_f22'].handler({ anio: 2025, folio: 900000001 });
    await tools['sii_renta_get_f22'].handler({ anio: 2025 });

    expect((scraper.f22Completo as jest.Mock).mock.calls)
      .toEqual([[2025, 900000001], [2025, undefined]]);
  });
});
