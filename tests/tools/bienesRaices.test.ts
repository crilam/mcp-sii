import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBienesRaicesTools } from '../../src/tools/bienesRaices';
import { BienesRaicesScraper } from '../../src/scrapers/bienesRaices';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/bienesRaices');
const MockScraper = BienesRaicesScraper as jest.MockedClass<typeof BienesRaicesScraper>;

function armar(rutRegistrado?: string) {
  const registro = {
    ejecutar: (rut: string, fn: any) => {
      if (rutRegistrado !== undefined && rut !== rutRegistrado) {
        return Promise.reject(new Error(`No hay sesión iniciada para el RUT ${rut}. Llamá sii_iniciar_sesion primero.`));
      }
      return fn({ obtenerBrowser: () => ({}) });
    },
  } as unknown as RegistroSesiones<any>;
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerBienesRaicesTools(server, registro);
  return { tools: (server as any)._registeredTools };
}

describe('registerBienesRaicesTools', () => {
  afterEach(() => jest.clearAllMocks());

  it('sin sesión iniciada devuelve SESION_NO_INICIADA', async () => {
    const { tools } = armar('22.222.222-2');

    const result = await tools['sii_persona_list_bienes_raices'].handler({ rut: '11.111.111-1' });

    expect(JSON.parse(result.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('consulta el listado de bienes raíces por la sesión del rut pedido', async () => {
    (MockScraper.prototype.listBienesRaices as jest.Mock).mockResolvedValue({
      resumen: { totalBienesRaices: 1 },
      propiedades: [{ rol: '123-45' }],
    });
    const { tools } = armar();

    const result = await tools['sii_persona_list_bienes_raices'].handler({ rut: '11.111.111-1' });

    expect(MockScraper.prototype.listBienesRaices).toHaveBeenCalled();
    expect(result.content[0].text).toContain('123-45');
  });
});
