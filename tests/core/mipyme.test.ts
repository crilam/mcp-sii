import { listEmpresas, listDteEmitidos, emitirDte } from '../../src/core/mipyme';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/mipymeHttp');
const MockScraper = MipymeHttpScraper as jest.MockedClass<typeof MipymeHttpScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/mipyme', () => {
  afterEach(() => jest.clearAllMocks());

  it('listEmpresas llama al scraper sin argumentos', async () => {
    (MockScraper.prototype.listEmpresas as jest.Mock).mockResolvedValue([]);
    await listEmpresas(registroQueEjecuta(), '11.111.111-1');
    expect(MockScraper.prototype.listEmpresas).toHaveBeenCalledWith();
  });

  it('listDteEmitidos pasa los filtros tal cual', async () => {
    (MockScraper.prototype.listDteEmitidos as jest.Mock).mockResolvedValue({ documentos: [] });
    const filtros = { empresaRut: '22222222-2', pagina: 1 };
    await listDteEmitidos(registroQueEjecuta(), '11.111.111-1', filtros as any);
    expect(MockScraper.prototype.listDteEmitidos).toHaveBeenCalledWith(filtros);
  });

  it('emitirDte pasa los params y el flag confirmar', async () => {
    (MockScraper.prototype.emitirDte as jest.Mock).mockResolvedValue({ emitido: false, resumen: {} });
    const params = { empresaRut: '22222222-2' } as any;
    await emitirDte(registroQueEjecuta(), '11.111.111-1', params, false);
    expect(MockScraper.prototype.emitirDte).toHaveBeenCalledWith(params, false);
  });
});
