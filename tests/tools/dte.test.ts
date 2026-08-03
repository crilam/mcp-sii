import { registerDteTools } from '../../src/tools/dte';
import { DteScraper } from '../../src/scrapers/dte';

jest.mock('../../src/scrapers/dte');
const MockScraper = DteScraper as jest.MockedClass<typeof DteScraper>;

function setup() {
  const tools: Record<string, { descripcion: string; schema: any; handler: Function }> = {};
  const server = {
    tool: (nombre: string, descripcion: string, schema: any, handler: Function) => {
      tools[nombre] = { descripcion, schema, handler };
    },
  };
  const scraper = new MockScraper({} as any, {} as any);
  registerDteTools(server as any, scraper);
  return { scraper, tools };
}

describe('registerDteTools', () => {
  it('registra las 4 tools de Consultas DTE', () => {
    const { tools } = setup();
    expect(tools['sii_dte_list_documentos_emitidos']).toBeDefined();
    expect(tools['sii_dte_get_documento_emitido']).toBeDefined();
    expect(tools['sii_dte_list_documentos_recibidos']).toBeDefined();
    expect(tools['sii_dte_get_documento_recibido']).toBeDefined();
  });

  // La advertencia no es cosmética: un modelo con las dos salidas a la vista y
  // sin este párrafo concluye que una de las dos fuentes está mal.
  it('las cuatro descripciones advierten que no son comparables con sii_rcv_*', () => {
    const { tools } = setup();
    for (const nombre of [
      'sii_dte_list_documentos_emitidos',
      'sii_dte_list_documentos_recibidos',
      'sii_dte_get_documento_emitido',
      'sii_dte_get_documento_recibido',
    ]) {
      expect(tools[nombre].descripcion).toContain('sii_rcv_');
      expect(tools[nombre].descripcion).toContain('NO cuadran');
    }
  });

  it('las descripciones de los listados explican la clave (tipo, sección)', () => {
    const { tools } = setup();
    for (const nombre of [
      'sii_dte_list_documentos_emitidos',
      'sii_dte_list_documentos_recibidos',
    ]) {
      expect(tools[nombre].descripcion).toContain('(tipoDocCodigo, seccion)');
      // Y que los totales confiables son la suma, no lo declarado.
      expect(tools[nombre].descripcion).toContain('totalesDeclarados');
    }
  });

  // Ninguna tool exige tener una empresa configurada: la empresa es parámetro.
  it('empresa_rut es opcional en las cuatro tools', () => {
    const { tools } = setup();
    for (const nombre of Object.keys(tools)) {
      expect(tools[nombre].schema.empresa_rut.isOptional()).toBe(true);
    }
  });

  it('el listado de emitidos llama al scraper con la operación EMITIDOS', async () => {
    const { scraper, tools } = setup();
    (scraper.listar as jest.Mock).mockResolvedValue({ documentos: [] });

    await tools['sii_dte_list_documentos_emitidos'].handler({
      periodo: '202607',
      empresa_rut: '22222222-2',
      tipo_doc: 33,
      contraparte_rut: '33333333-3',
      limit: 10,
      incluir_detalle: true,
    });

    expect(scraper.listar).toHaveBeenCalledWith('202607', 'EMITIDOS', {
      empresaRut: '22222222-2',
      tipoDocCodigo: 33,
      seccion: undefined,
      contraparteRut: '33333333-3',
      limit: 10,
      incluirDetalle: true,
    });
  });

  it('el listado de recibidos llama al scraper con la operación RECIBIDOS', async () => {
    const { scraper, tools } = setup();
    (scraper.listar as jest.Mock).mockResolvedValue({ documentos: [] });

    await tools['sii_dte_list_documentos_recibidos'].handler({
      periodo: '202607',
      incluir_detalle: false,
    });

    expect(scraper.listar).toHaveBeenCalledWith('202607', 'RECIBIDOS', {
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
      const schema = tools[nombre].schema;
      expect(schema.incluir_detalle.parse(undefined)).toBe(false);
      // Y la descripción dice que el uso normal es resumen primero.
      expect(tools[nombre].descripcion).toContain('incluir_detalle=true');
      // La consulta es mensual: nadie debería esperar un rango de fechas.
      expect(tools[nombre].descripcion).toContain('POR PERÍODO MENSUAL');
      expect(tools[nombre].descripcion).toContain('NO existe consulta por rango de fechas');
    }
  });

  // limit y contraparte_rut sobrevivieron a la migración, pero filtran del lado
  // del cliente: la descripción tiene que decir que no ahorran consultas.
  it('limit y contraparte_rut existen y se declaran como filtros del cliente', () => {
    const { tools } = setup();
    for (const nombre of [
      'sii_dte_list_documentos_emitidos',
      'sii_dte_list_documentos_recibidos',
    ]) {
      const schema = tools[nombre].schema;
      expect(schema.limit.isOptional()).toBe(true);
      expect(schema.contraparte_rut.isOptional()).toBe(true);
      expect(schema.limit.description).toContain('NO ');
      expect(schema.contraparte_rut.description).toContain('NO reduce las consultas al SII');
    }
  });

  it('el documento puntual pasa tipo, folio y operación', async () => {
    const { scraper, tools } = setup();
    (scraper.getDocumento as jest.Mock).mockResolvedValue({ encontrado: false });

    await tools['sii_dte_get_documento_recibido'].handler({
      periodo: '202607',
      tipo_doc: 61,
      folio: 1001,
      empresa_rut: '22222222-2',
    });

    expect(scraper.getDocumento).toHaveBeenCalledWith(
      '202607', 'RECIBIDOS', 61, 1001, '22222222-2'
    );
  });
});
