import { registerBheTools } from '../../src/tools/bhe';
import { BheScraper } from '../../src/scrapers/bhe';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/bhe');

const MockScraper = BheScraper as jest.MockedClass<typeof BheScraper>;

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
  registerBheTools(server as any, registro);
  return { tools };
}

describe('registerBheTools', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra sii_bhe_resumen', () => {
    const { tools } = registrar();

    expect(Object.keys(tools)).toContain('sii_bhe_resumen');
  });

  // Las tools de persona natural no dependen de la empresa seleccionada, y la
  // descripción es lo único que ve el modelo para decidir cuándo usarlas.
  it('describe la tool como colgando de la persona, no de la empresa', () => {
    const { tools } = registrar();

    expect(tools['sii_bhe_resumen'].descripcion).toMatch(/SII_EMPRESA_RUT/);
  });

  it('exige el rut de la sesión en el schema', () => {
    const { tools } = registrar();

    expect(tools['sii_bhe_resumen'].schema.rut.isOptional()).toBe(false);
  });

  it('sin sesión iniciada devuelve SESION_NO_INICIADA', async () => {
    const { tools } = registrar('22.222.222-2');

    const result = await tools['sii_bhe_resumen'].handler({ rut: '11.111.111-1', anio: 2025 });

    expect(JSON.parse(result.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('devuelve el informe del año pedido como JSON', async () => {
    (MockScraper.prototype.informeAnual as jest.Mock).mockResolvedValue({
      anio: 2025,
      rut: '11111111-1',
      nombreContribuyente: 'JUAN PEREZ SOTO',
      meses: [],
      folioInicial: null,
      folioFinal: null,
    });
    const { tools } = registrar();

    const result = await tools['sii_bhe_resumen'].handler({ rut: '11.111.111-1', anio: 2025 });

    expect(MockScraper.prototype.informeAnual).toHaveBeenCalledWith(2025);
    expect(JSON.parse(result.content[0].text).anio).toBe(2025);
  });

  it('registra sii_bhe_list_emitidas y sii_bhe_list_recibidas', () => {
    const { tools } = registrar();

    expect(Object.keys(tools)).toContain('sii_bhe_list_emitidas');
    expect(Object.keys(tools)).toContain('sii_bhe_list_recibidas');
  });

  it('sii_bhe_list_recibidas invoca al scraper con recibidas en true', async () => {
    (MockScraper.prototype.informeMensual as jest.Mock).mockResolvedValue([]);
    const { tools } = registrar();

    await tools['sii_bhe_list_recibidas'].handler({ rut: '11.111.111-1', anio: 2025, mes: 5 });

    expect(MockScraper.prototype.informeMensual).toHaveBeenCalledWith(2025, 5, true);
  });
});
