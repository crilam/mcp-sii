import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMipymeTools } from '../../src/tools/mipyme';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/mipymeHttp');
const MockHttp = MipymeHttpScraper as jest.MockedClass<typeof MipymeHttpScraper>;

// El registro real resuelve la sesión por RUT; acá alcanza con una versión
// falsa que ejecuta `fn` con una sesión cualquiera (los scrapers están
// mockeados, no les importa qué reciben) y deja registrado el rut invocado.
function armar(rutRegistrado?: string) {
  const sesionFake = {} as any;
  const registro = {
    ejecutar: (rut: string, fn: any) => {
      if (rutRegistrado !== undefined && rut !== rutRegistrado) {
        return Promise.reject(new Error(`No hay sesión iniciada para el RUT ${rut}. Llamá sii_iniciar_sesion primero.`));
      }
      return fn(sesionFake);
    },
  } as unknown as RegistroSesiones<any>;
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerMipymeTools(server, registro);
  return { tools: (server as any)._registeredTools };
}

// Estas tools leen SII_EMPRESA_RUT del entorno, así que se restaura el env
// completo después de cada test: mutarlo sin devolverlo contamina los que
// siguen según el orden en que jest los corra.
describe('registerMipymeTools', () => {
  const envOriginal = { ...process.env };
  afterEach(() => {
    process.env = { ...envOriginal };
    jest.clearAllMocks();
    require('../../src/core/mipyme').ventanaBorrador._reset();
  });

  it('sii_mipyme_list_empresas consulta por HTTP', async () => {
    (MockHttp.prototype.listEmpresas as jest.Mock).mockResolvedValue([
      { rut: '22222222-2', nombre: 'EMPRESA A' },
    ]);
    const { tools } = armar();

    const result = await tools['sii_mipyme_list_empresas'].handler({ rut: '11.111.111-1' });

    expect(MockHttp.prototype.listEmpresas).toHaveBeenCalled();
    expect(result.content[0].text).toContain('22222222-2');
  });

  it('sin sesión iniciada devuelve SESION_NO_INICIADA', async () => {
    const { tools } = armar('22.222.222-2');

    const result = await tools['sii_mipyme_list_empresas'].handler({ rut: '11.111.111-1' });

    expect(JSON.parse(result.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('sii_mipyme_list_dte_emitidos pasa los filtros al scraper HTTP', async () => {
    (MockHttp.prototype.listDteEmitidos as jest.Mock).mockResolvedValue({
      documentos: [], pagina: 1, totalPaginas: 3, empresaRut: '22222222-2',
    });
    const { tools } = armar();

    await tools['sii_mipyme_list_dte_emitidos'].handler({
      rut: '11.111.111-1',
      empresa_rut: '22222222-2',
      fecha_desde: '2026-01-01',
      fecha_hasta: '2026-01-31',
      pagina: 2,
    });

    expect(MockHttp.prototype.listDteEmitidos).toHaveBeenCalledWith(
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
    (MockHttp.prototype.listDteEmitidos as jest.Mock).mockResolvedValue({
      documentos: [], pagina: 1, totalPaginas: 1, empresaRut: '22222222-2',
    });
    const { tools } = armar();

    await tools['sii_mipyme_list_dte_emitidos'].handler({ rut: '11.111.111-1', pagina: 1 });

    expect(MockHttp.prototype.listDteEmitidos).toHaveBeenCalledWith(
      expect.objectContaining({ empresaRut: undefined })
    );
  });

  it('sii_mipyme_list_dte_emitidos usa SII_EMPRESA_RUT cuando no viene empresa_rut', async () => {
    (MockHttp.prototype.listDteEmitidos as jest.Mock).mockResolvedValue({
      documentos: [], pagina: 1, totalPaginas: 1, empresaRut: '44444444-4',
    });
    process.env.SII_EMPRESA_RUT = '44444444-4';
    const { tools } = armar();

    await tools['sii_mipyme_list_dte_emitidos'].handler({ rut: '11.111.111-1', pagina: 1 });

    expect(MockHttp.prototype.listDteEmitidos).toHaveBeenCalledWith(
      expect.objectContaining({ empresaRut: '44444444-4' })
    );
  });

  // Los tres tests que siguen cubren el default que evita emitir por accidente.
  const emisionMinima = {
    rut: '11.111.111-1',
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
    (MockHttp.prototype.emitirDte as jest.Mock).mockResolvedValue({
      emitido: false,
      resumen: { neto: 100000, iva: 19000, total: 119000 },
      campos: { EFXP_MNT_TOTAL: '119000' },
    });
    const { tools } = armar();

    const result = await tools['sii_mipyme_emitir_dte'].handler(emisionMinima);

    // El segundo argumento es el que firma: tiene que llegar en false.
    expect(MockHttp.prototype.emitirDte).toHaveBeenCalledWith(expect.anything(), false);
    // Y la respuesta tiene que decir que NO se emitió: un resumen con montos,
    // sin aviso, se lee como un documento ya emitido.
    expect(result.content[0].text).toMatch(/NO emitido/i);
  });

  it('sii_mipyme_emitir_dte firma sólo con confirmar=true', async () => {
    (MockHttp.prototype.emitirDte as jest.Mock).mockResolvedValue({
      emitido: true,
      folio: 1234,
      resumen: { neto: 100000, iva: 19000, total: 119000 },
    });
    const { tools } = armar();

    const result = await tools['sii_mipyme_emitir_dte'].handler({
      ...emisionMinima,
      confirmar: true,
    });

    expect(MockHttp.prototype.emitirDte).toHaveBeenCalledWith(expect.anything(), true);
    expect(result.content[0].text).toContain('1234');
  });

  it('sii_mipyme_guardar_borrador simula por defecto y NO graba', async () => {
    (MockHttp.prototype.guardarBorrador as jest.Mock).mockResolvedValue({ guardado: false, resumen: {}, borradorId: null });
    const { tools } = armar();

    const result = await tools['sii_mipyme_guardar_borrador'].handler(emisionMinima);

    // El segundo arg (confirmar) llega false; el borrador_id (tercero) undefined.
    expect(MockHttp.prototype.guardarBorrador).toHaveBeenCalledWith(expect.anything(), false, undefined);
    expect(result.content[0].text).toMatch(/Sólo simulación|NO se guardó/i);
  });

  it('sii_mipyme_guardar_borrador: empresaPedida pisa el empresaRut del documento', async () => {
    process.env.SII_EMPRESA_RUT = '99999999-9';
    (MockHttp.prototype.guardarBorrador as jest.Mock).mockResolvedValue({ guardado: true, resumen: {}, borradorId: null });
    const { tools } = armar();

    // El body NO trae empresa_rut → debe usar SII_EMPRESA_RUT, no undefined.
    const sinEmpresa: Record<string, unknown> = { ...emisionMinima };
    delete sinEmpresa.empresa_rut;
    await tools['sii_mipyme_guardar_borrador'].handler({ ...sinEmpresa, confirmar: true, borrador_id: '77' });

    const params = (MockHttp.prototype.guardarBorrador as jest.Mock).mock.calls[0][0];
    expect(params.empresaRut).toBe('99999999-9');
    expect(MockHttp.prototype.guardarBorrador).toHaveBeenCalledWith(expect.anything(), true, '77');
  });

  it('sii_mipyme_emitir_dte avisa que el folio emitido está pendiente de verificación', async () => {
    // El folio sale de la página de firma (el propuesto): la respuesta de
    // mipeSendXML no está relevada, así que no se puede afirmar que ese sea el
    // folio asignado. Reportarlo sin salvedad es el falso positivo del "folio
    // 21". La tool tiene que decir que hay que confirmarlo contra el historial.
    (MockHttp.prototype.emitirDte as jest.Mock).mockResolvedValue({
      emitido: true,
      folio: 1234,
      resumen: { neto: 100000, iva: 19000, total: 119000 },
    });
    const { tools } = armar();

    const result = await tools['sii_mipyme_emitir_dte'].handler({
      ...emisionMinima,
      confirmar: true,
    });

    expect(result.content[0].text).toMatch(/verificar|pendiente|confirmar/i);
    expect(result.content[0].text).toContain('sii_mipyme_list_dte_emitidos');
  });

  it('sii_mipyme_emitir_dte traduce los nombres de los campos al contrato del scraper', async () => {
    (MockHttp.prototype.emitirDte as jest.Mock).mockResolvedValue({
      emitido: false, resumen: {}, campos: {},
    });
    const { tools } = armar();

    await tools['sii_mipyme_emitir_dte'].handler({
      ...emisionMinima,
      referencias: [{ tipo_doc: 33, folio: 244, fecha: '2026-08-01', codigo: 1 }],
    });

    expect(MockHttp.prototype.emitirDte).toHaveBeenCalledWith(
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
