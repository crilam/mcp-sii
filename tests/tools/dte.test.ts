import { registerDteTools } from '../../src/tools/dte';
import { DteScraper } from '../../src/scrapers/dte';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/dte');
const MockScraper = DteScraper as jest.MockedClass<typeof DteScraper>;

function setup(rutRegistrado?: string) {
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
  registerDteTools(server as any, registro);
  return { tools };
}

describe('registerDteTools', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 4 tools de Consultas DTE', () => {
    const { tools } = setup();
    expect(tools['sii_dte_list_documentos_emitidos']).toBeDefined();
    expect(tools['sii_dte_get_documento_emitido']).toBeDefined();
    expect(tools['sii_dte_list_documentos_recibidos']).toBeDefined();
    expect(tools['sii_dte_get_documento_recibido']).toBeDefined();
  });

  // Lo único que se verifica de la prosa: que las cuatro nombren sii_rcv_*, que
  // es un requisito del relevamiento (sin eso, un modelo con las dos salidas a
  // la vista concluye que una de las dos fuentes está mal). No se assertean
  // frases: repetir la copia en un test no detecta ningún error de lógica y se
  // rompe al reescribir una oración.
  it('las cuatro descripciones nombran sii_rcv_* para advertir que no son comparables', () => {
    const { tools } = setup();
    for (const nombre of Object.keys(tools)) {
      expect(tools[nombre].descripcion).toContain('sii_rcv_');
    }
  });

  // Ninguna tool exige tener una empresa configurada: la empresa es parámetro.
  it('empresa_rut es opcional en las cuatro tools', () => {
    const { tools } = setup();
    for (const nombre of Object.keys(tools)) {
      expect(tools[nombre].schema.empresa_rut.isOptional()).toBe(true);
    }
  });

  it('rut es obligatorio en las cuatro tools', () => {
    const { tools } = setup();
    for (const nombre of Object.keys(tools)) {
      expect(tools[nombre].schema.rut.isOptional()).toBe(false);
    }
  });

  it('sin sesión iniciada devuelve SESION_NO_INICIADA', async () => {
    const { tools } = setup('22.222.222-2');

    const resultado = await tools['sii_dte_list_documentos_emitidos'].handler({
      rut: '11.111.111-1',
      periodo: '202607',
      incluir_detalle: false,
    });

    expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('el listado de emitidos llama al scraper con la operación EMITIDOS', async () => {
    (MockScraper.prototype.listar as jest.Mock).mockResolvedValue({ documentos: [] });
    const { tools } = setup();

    await tools['sii_dte_list_documentos_emitidos'].handler({
      rut: '11.111.111-1',
      periodo: '202607',
      empresa_rut: '22222222-2',
      tipo_doc: 33,
      contraparte_rut: '33333333-3',
      limit: 10,
      incluir_detalle: true,
    });

    expect(MockScraper.prototype.listar).toHaveBeenCalledWith('202607', 'EMITIDOS', {
      empresaRut: '22222222-2',
      tipoDocCodigo: 33,
      seccion: undefined,
      contraparteRut: '33333333-3',
      limit: 10,
      incluirDetalle: true,
    });
  });

  it('el listado de recibidos llama al scraper con la operación RECIBIDOS', async () => {
    (MockScraper.prototype.listar as jest.Mock).mockResolvedValue({ documentos: [] });
    const { tools } = setup();

    await tools['sii_dte_list_documentos_recibidos'].handler({
      rut: '11.111.111-1',
      periodo: '202607',
      incluir_detalle: false,
    });

    expect(MockScraper.prototype.listar).toHaveBeenCalledWith('202607', 'RECIBIDOS', {
      empresaRut: undefined,
      tipoDocCodigo: undefined,
      seccion: undefined,
      contraparteRut: undefined,
      limit: undefined,
      incluirDetalle: false,
    });
  });

  // Lo costoso se pide explícitamente: el detalle dispara una consulta al SII
  // por cada fila del resumen, así que el default no puede traerlo.
  it('incluir_detalle es opt-in: su default es false', () => {
    const { tools } = setup();
    for (const nombre of [
      'sii_dte_list_documentos_emitidos',
      'sii_dte_list_documentos_recibidos',
    ]) {
      expect(tools[nombre].schema.incluir_detalle.parse(undefined)).toBe(false);
    }
  });

  // El período es obligatorio y mensual: el esquema tiene que rechazar un rango
  // de fechas, no sólo desaconsejarlo en la descripción.
  it('el período es obligatorio y sólo acepta AAAAMM', () => {
    const { tools } = setup();
    for (const nombre of Object.keys(tools)) {
      const periodo = tools[nombre].schema.periodo;
      expect(periodo.isOptional()).toBe(false);
      expect(periodo.safeParse('202607').success).toBe(true);
      expect(periodo.safeParse('2026-07').success).toBe(false);
      expect(periodo.safeParse('2026-07-01').success).toBe(false);
    }
  });

  // Los filtros del cliente exigen el detalle, y el que decide es el scraper:
  // acá se verifica que la tool le pase el pedido tal cual, sin apagar el error.
  it('propaga el error del scraper cuando se filtra sin detalle', async () => {
    (MockScraper.prototype.listar as jest.Mock).mockRejectedValue(new Error('requieren incluirDetalle=true'));
    const { tools } = setup();

    await expect(
      tools['sii_dte_list_documentos_emitidos'].handler({
        rut: '11.111.111-1',
        periodo: '202607',
        contraparte_rut: '33333333-3',
        incluir_detalle: false,
      })
    ).rejects.toThrow(/incluirDetalle=true/);
  });

  // limit y contraparte_rut sobrevivieron a la migración: filtran del lado del
  // cliente y exigen el detalle.
  it('limit y contraparte_rut existen y son opcionales', () => {
    const { tools } = setup();
    for (const nombre of [
      'sii_dte_list_documentos_emitidos',
      'sii_dte_list_documentos_recibidos',
    ]) {
      const schema = tools[nombre].schema;
      expect(schema.limit.isOptional()).toBe(true);
      expect(schema.contraparte_rut.isOptional()).toBe(true);
      // Y el esquema rechaza un limit sin sentido, no sólo el scraper.
      expect(schema.limit.safeParse(0).success).toBe(false);
      expect(schema.limit.safeParse(50).success).toBe(true);
    }
  });

  it('el documento puntual pasa tipo, folio y operación', async () => {
    (MockScraper.prototype.getDocumento as jest.Mock).mockResolvedValue({ encontrado: false });
    const { tools } = setup();

    await tools['sii_dte_get_documento_recibido'].handler({
      rut: '11.111.111-1',
      periodo: '202607',
      tipo_doc: 61,
      folio: 1001,
      empresa_rut: '22222222-2',
    });

    expect(MockScraper.prototype.getDocumento).toHaveBeenCalledWith(
      '202607', 'RECIBIDOS', 61, 1001, '22222222-2'
    );
  });
});
