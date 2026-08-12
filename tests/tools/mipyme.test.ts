import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMipymeTools } from '../../src/tools/mipyme';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';

jest.mock('../../src/scrapers/mipymeHttp');
const MockHttp = MipymeHttpScraper as jest.MockedClass<typeof MipymeHttpScraper>;

function armar() {
  const http = new MockHttp({} as any, {} as any);
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerMipymeTools(server, http);
  return { http, tools: (server as any)._registeredTools };
}

// Estas tools leen SII_EMPRESA_RUT del entorno, así que se restaura el env
// completo después de cada test: mutarlo sin devolverlo contamina los que
// siguen según el orden en que jest los corra.
describe('registerMipymeTools', () => {
  const envOriginal = { ...process.env };
  afterEach(() => {
    process.env = { ...envOriginal };
  });

  it('sii_mipyme_list_empresas consulta por HTTP', async () => {
    const { http, tools } = armar();
    (http.listEmpresas as jest.Mock).mockResolvedValue([
      { rut: '22222222-2', nombre: 'EMPRESA A' },
    ]);

    const result = await tools['sii_mipyme_list_empresas'].handler({});

    expect(http.listEmpresas).toHaveBeenCalled();
    expect(result.content[0].text).toContain('22222222-2');
  });

  it('sii_mipyme_list_dte_emitidos pasa los filtros al scraper HTTP', async () => {
    const { http, tools } = armar();
    (http.listDteEmitidos as jest.Mock).mockResolvedValue({
      documentos: [], pagina: 1, totalPaginas: 3, empresaRut: '22222222-2',
    });

    await tools['sii_mipyme_list_dte_emitidos'].handler({
      empresa_rut: '22222222-2',
      fecha_desde: '2026-01-01',
      fecha_hasta: '2026-01-31',
      pagina: 2,
    });

    expect(http.listDteEmitidos).toHaveBeenCalledWith(
      expect.objectContaining({
        empresaRut: '22222222-2',
        fechaDesde: '2026-01-01',
        fechaHasta: '2026-01-31',
        pagina: 2,
      })
    );
  });

  // Sin empresa_rut ni SII_EMPRESA_RUT la tool NO falla: delega en el scraper,
  // que la resuelve sola si este RUT opera una única empresa. Falla recién con
  // varias, y ese caso lo cubre el test del scraper.
  it('sii_mipyme_list_dte_emitidos delega la resolución de empresa al scraper', async () => {
    const { http, tools } = armar();
    (http.listDteEmitidos as jest.Mock).mockResolvedValue({
      documentos: [], pagina: 1, totalPaginas: 1, empresaRut: '22222222-2',
    });

    await tools['sii_mipyme_list_dte_emitidos'].handler({ pagina: 1 });

    expect(http.listDteEmitidos).toHaveBeenCalledWith(
      expect.objectContaining({ empresaRut: undefined })
    );
  });

  it('sii_mipyme_list_dte_emitidos usa SII_EMPRESA_RUT cuando no viene empresa_rut', async () => {
    const { http, tools } = armar();
    (http.listDteEmitidos as jest.Mock).mockResolvedValue({
      documentos: [], pagina: 1, totalPaginas: 1, empresaRut: '44444444-4',
    });
    process.env.SII_EMPRESA_RUT = '44444444-4';

    await tools['sii_mipyme_list_dte_emitidos'].handler({ pagina: 1 });

    expect(http.listDteEmitidos).toHaveBeenCalledWith(
      expect.objectContaining({ empresaRut: '44444444-4' })
    );
  });

  // Los tres tests que siguen cubren el default que evita emitir por accidente.
  const emisionMinima = {
    tipo_dte: 33,
    receptor_rut: '33333333-3',
    receptor_dv: '3',
    receptor_razon_social: 'CLIENTE SPA',
    receptor_giro: 'SERVICIOS',
    receptor_direccion: 'CALLE FICTICIA 200',
    receptor_comuna: 'COMUNA DOS',
    receptor_ciudad: 'CIUDAD DOS',
    lineas: [{ descripcion: 'Servicio', cantidad: 1, precio_unitario: 100000 }],
    confirmar: false,
  };

  it('sii_mipyme_emitir_dte NO emite si no le pasan confirmar', async () => {
    const { http, tools } = armar();
    (http.emitirDte as jest.Mock).mockResolvedValue({
      emitido: false,
      resumen: { neto: 100000, iva: 19000, total: 119000 },
      campos: { EFXP_MNT_TOTAL: '119000' },
    });

    const result = await tools['sii_mipyme_emitir_dte'].handler(emisionMinima);

    // El segundo argumento es el que firma: tiene que llegar en false.
    expect(http.emitirDte).toHaveBeenCalledWith(expect.anything(), false);
    // Y la respuesta tiene que decir que NO se emitió: un resumen con montos,
    // sin aviso, se lee como un documento ya emitido.
    expect(result.content[0].text).toMatch(/NO emitido/i);
  });

  it('sii_mipyme_emitir_dte firma sólo con confirmar=true', async () => {
    const { http, tools } = armar();
    (http.emitirDte as jest.Mock).mockResolvedValue({
      emitido: true,
      folio: 1234,
      resumen: { neto: 100000, iva: 19000, total: 119000 },
    });

    const result = await tools['sii_mipyme_emitir_dte'].handler({
      ...emisionMinima,
      confirmar: true,
    });

    expect(http.emitirDte).toHaveBeenCalledWith(expect.anything(), true);
    expect(result.content[0].text).toContain('1234');
  });

  it('sii_mipyme_emitir_dte avisa que el folio emitido está pendiente de verificación', async () => {
    // El folio sale de la página de firma (el propuesto): la respuesta de
    // mipeSendXML no está relevada, así que no se puede afirmar que ese sea el
    // folio asignado. Reportarlo sin salvedad es el falso positivo del "folio
    // 21". La tool tiene que decir que hay que confirmarlo contra el historial.
    const { http, tools } = armar();
    (http.emitirDte as jest.Mock).mockResolvedValue({
      emitido: true,
      folio: 1234,
      resumen: { neto: 100000, iva: 19000, total: 119000 },
    });

    const result = await tools['sii_mipyme_emitir_dte'].handler({
      ...emisionMinima,
      confirmar: true,
    });

    expect(result.content[0].text).toMatch(/verificar|pendiente|confirmar/i);
    expect(result.content[0].text).toContain('sii_mipyme_list_dte_emitidos');
  });

  it('sii_mipyme_emitir_dte traduce los nombres de los campos al contrato del scraper', async () => {
    const { http, tools } = armar();
    (http.emitirDte as jest.Mock).mockResolvedValue({
      emitido: false, resumen: {}, campos: {},
    });

    await tools['sii_mipyme_emitir_dte'].handler({
      ...emisionMinima,
      referencias: [{ tipo_doc: 33, folio: 244, fecha: '2026-08-01', codigo: 1 }],
    });

    expect(http.emitirDte).toHaveBeenCalledWith(
      expect.objectContaining({
        tipoDte: 33,
        receptor: expect.objectContaining({ rut: '33333333-3', dv: '3' }),
        lineas: [{ nombre: 'Servicio', cantidad: 1, precioUnitario: 100000, unidad: undefined }],
        referencias: [{ tipoDoc: 33, folio: 244, fecha: '2026-08-01', razon: undefined, codigo: 1 }],
      }),
      false
    );
  });

  it('la descripción avisa que emitir es irreversible y que por defecto no emite', async () => {
    const { tools } = armar();
    const descripcion = tools['sii_mipyme_emitir_dte'].description;

    expect(descripcion).toMatch(/IRREVERSIBLE/i);
    expect(descripcion).toMatch(/NO EMITE/i);
    // El 404 de mipeDocAlta.cgi ya no corresponde: el camino se migró.
    expect(descripcion).not.toMatch(/404/);
  });
});
