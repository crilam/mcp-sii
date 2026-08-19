import { listar, getDocumento } from '../../src/core/dte';
import { DteScraper } from '../../src/scrapers/dte';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/dte');
const MockScraper = DteScraper as jest.MockedClass<typeof DteScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/dte', () => {
  afterEach(() => jest.clearAllMocks());

  it('listar arma las opciones y pasa la operación', async () => {
    (MockScraper.prototype.listar as jest.Mock).mockResolvedValue({ filas: [] });
    await listar(registroQueEjecuta(), '11.111.111-1', '202607', 'EMITIDOS', {
      empresaRut: '22222222-2', tipoDocCodigo: 33, seccion: 'S1', contraparteRut: undefined, limit: undefined, incluirDetalle: false,
    });
    expect(MockScraper.prototype.listar).toHaveBeenCalledWith('202607', 'EMITIDOS', {
      empresaRut: '22222222-2', tipoDocCodigo: 33, seccion: 'S1', contraparteRut: undefined, limit: undefined, incluirDetalle: false,
    });
  });

  it('getDocumento pasa periodo, operacion, tipo_doc, folio y empresa', async () => {
    (MockScraper.prototype.getDocumento as jest.Mock).mockResolvedValue({ encontrado: true });
    await getDocumento(registroQueEjecuta(), '11.111.111-1', '202607', 'RECIBIDOS', 33, 100, '22222222-2');
    expect(MockScraper.prototype.getDocumento).toHaveBeenCalledWith('202607', 'RECIBIDOS', 33, 100, '22222222-2');
  });
});
