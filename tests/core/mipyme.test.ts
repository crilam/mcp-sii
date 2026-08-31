import { listEmpresas, listDteEmitidos, emitirDte, guardarBorrador, _resetIdempotenciaBorrador } from '../../src/core/mipyme';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';
import { RegistroSesiones } from '../../src/registroSesiones';
import { LimitacionConocida } from '../../src/erroresConsulta';
import { marcarSeguro } from '../../src/idempotenciaEscritura';

jest.mock('../../src/scrapers/mipymeHttp');
const MockScraper = MipymeHttpScraper as jest.MockedClass<typeof MipymeHttpScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}
const DOC = { empresaRut: '22222222-2', tipoDte: 33, receptor: { rut: '33333333', dv: '1' }, lineas: [{ nombre: 'X', cantidad: 1, precioUnitario: 1000 }] } as any;

describe('core/mipyme', () => {
  afterEach(() => { jest.clearAllMocks(); _resetIdempotenciaBorrador(); });

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

  describe('guardarBorrador — idempotencia anti-doble-click', () => {
    it('una SIMULACIÓN repetida no se bloquea (no muta)', async () => {
      (MockScraper.prototype.guardarBorrador as jest.Mock).mockResolvedValue({ guardado: false, resumen: {}, borradorId: null });
      await guardarBorrador(registroQueEjecuta(), '11111111', DOC, false);
      await guardarBorrador(registroQueEjecuta(), '11111111', DOC, false);
      expect(MockScraper.prototype.guardarBorrador).toHaveBeenCalledTimes(2);
    });

    it('un grabado repetido (confirmar:true) se bloquea la segunda vez', async () => {
      (MockScraper.prototype.guardarBorrador as jest.Mock).mockResolvedValue({ guardado: true, resumen: {}, borradorId: null });
      await guardarBorrador(registroQueEjecuta(), '22222222', DOC, true);
      await expect(guardarBorrador(registroQueEjecuta(), '22222222', DOC, true)).rejects.toBeInstanceOf(LimitacionConocida);
      expect(MockScraper.prototype.guardarBorrador).toHaveBeenCalledTimes(1);
    });

    it('un rechazo marcado seguro libera la reserva y el reintento graba', async () => {
      (MockScraper.prototype.guardarBorrador as jest.Mock)
        .mockRejectedValueOnce(marcarSeguro(new Error('rechazo del SII')))
        .mockResolvedValueOnce({ guardado: true, resumen: {}, borradorId: null });
      await expect(guardarBorrador(registroQueEjecuta(), '33333333', DOC, true)).rejects.toThrow(/rechazo/);
      await guardarBorrador(registroQueEjecuta(), '33333333', DOC, true);
      expect(MockScraper.prototype.guardarBorrador).toHaveBeenCalledTimes(2);
    });

    it('borradores DISTINTOS no comparten la traba', async () => {
      (MockScraper.prototype.guardarBorrador as jest.Mock).mockResolvedValue({ guardado: true, resumen: {}, borradorId: null });
      await guardarBorrador(registroQueEjecuta(), '44444444', DOC, true);
      await guardarBorrador(registroQueEjecuta(), '44444444', { ...DOC, tipoDte: 34 }, true);
      expect(MockScraper.prototype.guardarBorrador).toHaveBeenCalledTimes(2);
    });
  });
});
