import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMipymeTools } from '../../src/tools/mipyme';
import { MipymeScraper } from '../../src/scrapers/mipyme';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';

jest.mock('../../src/scrapers/mipyme');
jest.mock('../../src/scrapers/mipymeHttp');
const MockScraper = MipymeScraper as jest.MockedClass<typeof MipymeScraper>;
const MockHttp = MipymeHttpScraper as jest.MockedClass<typeof MipymeHttpScraper>;

function armar() {
  const http = new MockHttp({} as any, {} as any);
  const navegador = new MockScraper({} as any, {} as any);
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerMipymeTools(server, http, navegador);
  return { http, navegador, tools: (server as any)._registeredTools };
}

describe('registerMipymeTools', () => {
  it('sii_mipyme_list_empresas consulta por HTTP, no por navegador', async () => {
    const { http, navegador, tools } = armar();
    (http.listEmpresas as jest.Mock).mockResolvedValue([
      { rut: '22222222-2', nombre: 'EMPRESA A' },
    ]);

    const result = await tools['sii_mipyme_list_empresas'].handler({});

    expect(http.listEmpresas).toHaveBeenCalled();
    expect(navegador.listEmpresas).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('22222222-2');
  });

  it('sii_mipyme_list_dte_emitidos pasa los filtros al scraper HTTP', async () => {
    const { http, tools } = armar();
    (http.listDteEmitidos as jest.Mock).mockResolvedValue({
      documentos: [], pagina: 1, empresaRut: '22222222-2',
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

  // Sin empresa no se puede consultar, y el error tiene que decir cómo salir del
  // paso en vez de dejar que el CGI responda un error genérico del portal.
  it('sii_mipyme_list_dte_emitidos falla nombrando la tool de listado si no hay empresa', async () => {
    const { http, tools } = armar();
    const previo = process.env.SII_EMPRESA_RUT;
    delete process.env.SII_EMPRESA_RUT;
    process.env.SII_RUT = '11111111-1';
    process.env.SII_CLAVE = 'x';

    await expect(tools['sii_mipyme_list_dte_emitidos'].handler({ pagina: 1 }))
      .rejects.toThrow(/sii_mipyme_list_empresas/);
    expect(http.listDteEmitidos).not.toHaveBeenCalled();

    if (previo !== undefined) process.env.SII_EMPRESA_RUT = previo;
  });

  it('sii_mipyme_emitir_dte sigue usando el navegador y avisa del 404 en su descripción', async () => {
    const { navegador, tools } = armar();
    (navegador.emitirDte as jest.Mock).mockResolvedValue({
      folio: 1234, tipoDte: 33, receptorRut: '33333333-3', total: 119000,
    });

    const result = await tools['sii_mipyme_emitir_dte'].handler({
      tipo_dte: 33,
      receptor_rut: '33333333-3',
      receptor_dv: '1',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precio_unitario: 100000 }],
    });

    expect(navegador.emitirDte).toHaveBeenCalledWith(
      expect.objectContaining({
        tipoDte: 33,
        receptorRut: '33333333-3',
        receptorDv: '1',
        lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100000 }],
      })
    );
    expect(result.content[0].text).toContain('1234');
    expect(tools['sii_mipyme_emitir_dte'].description).toMatch(/404/);
  });
});
