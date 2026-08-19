import { resumen, detalle } from '../../src/core/rcv';
import { RcvScraper } from '../../src/scrapers/rcv';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/rcv');
const MockScraper = RcvScraper as jest.MockedClass<typeof RcvScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/rcv', () => {
  afterEach(() => jest.clearAllMocks());

  it('resumen pasa período, operación y empresa al scraper y devuelve el dato crudo', async () => {
    (MockScraper.prototype.resumen as jest.Mock).mockResolvedValue({ filas: [] });
    const registro = registroQueEjecuta();

    const resultado = await resumen(registro, '11.111.111-1', '202607', 'VENTA', '22222222-2');

    expect(MockScraper.prototype.resumen).toHaveBeenCalledWith('202607', 'VENTA', '22222222-2');
    expect(resultado).toEqual({ filas: [] });
  });

  it('detalle pasa período, operación, tipo_doc y empresa al scraper', async () => {
    (MockScraper.prototype.detalle as jest.Mock).mockResolvedValue({ documentos: [] });
    const registro = registroQueEjecuta();

    const resultado = await detalle(registro, '11.111.111-1', '202607', 'COMPRA', 33, undefined);

    expect(MockScraper.prototype.detalle).toHaveBeenCalledWith('202607', 'COMPRA', 33, undefined);
    expect(resultado).toEqual({ documentos: [] });
  });

  it('propaga el error de sesión sin traducirlo (eso lo hace cada adaptador)', async () => {
    const registro = {
      ejecutar: () => Promise.reject(new Error('No hay sesión iniciada para el RUT 1. Llamá sii_iniciar_sesion primero.')),
    } as unknown as RegistroSesiones<any>;

    await expect(resumen(registro, '1', '202607', 'VENTA')).rejects.toThrow('No hay sesión iniciada');
  });
});
