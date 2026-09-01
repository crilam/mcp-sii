import * as core from '../../src/core/bheEmision';
import { BheEmisionScraper } from '../../src/scrapers/bheEmision';
import { LimitacionConocida } from '../../src/erroresConsulta';
import { marcarSeguro } from '../../src/idempotenciaEscritura';

jest.mock('../../src/scrapers/bheEmision', () => {
  const actual = jest.requireActual('../../src/scrapers/bheEmision');
  return { ...actual, BheEmisionScraper: jest.fn() };
});

const MockScraper = BheEmisionScraper as jest.MockedClass<typeof BheEmisionScraper>;
(MockScraper.prototype as any).emitir = jest.fn();

const registro = { ejecutar: (_r: string, fn: any) => fn({}) } as any;
const PARAMS = {
  receptor: { rut: '96949020-K', nombre: 'ORSAN' },
  lineas: [{ descripcion: 'Dieta', valor: 1226213 }],
} as any;

describe('core.emitirBhe — idempotencia', () => {
  afterEach(() => { jest.clearAllMocks(); core.ventanaBhe._reset(); });

  it('la previsualización repetida no se bloquea (no emite)', async () => {
    (MockScraper.prototype.emitir as jest.Mock).mockResolvedValue({ emitida: false });
    await core.emitirBhe(registro, '11111111', PARAMS, false);
    await core.emitirBhe(registro, '11111111', PARAMS, false);
    expect(MockScraper.prototype.emitir).toHaveBeenCalledTimes(2);
  });

  it('la MISMA boleta con confirmar:true dos veces se bloquea la segunda', async () => {
    (MockScraper.prototype.emitir as jest.Mock).mockResolvedValue({ emitida: true, folio: 1 });
    await core.emitirBhe(registro, '22222222', PARAMS, true);
    await expect(core.emitirBhe(registro, '22222222', PARAMS, true)).rejects.toBeInstanceOf(LimitacionConocida);
    expect(MockScraper.prototype.emitir).toHaveBeenCalledTimes(1);
  });

  it('un rechazo marcado seguro (fase de previsualización) libera y el reintento emite', async () => {
    (MockScraper.prototype.emitir as jest.Mock)
      .mockRejectedValueOnce(marcarSeguro(new Error('rechazo del SII')))
      .mockResolvedValueOnce({ emitida: true, folio: 2 });
    await expect(core.emitirBhe(registro, '33333333', PARAMS, true)).rejects.toThrow(/rechazo/);
    await core.emitirBhe(registro, '33333333', PARAMS, true);
    expect(MockScraper.prototype.emitir).toHaveBeenCalledTimes(2);
  });

  it('un error SIN marca (paso 4 ambiguo) mantiene la reserva', async () => {
    (MockScraper.prototype.emitir as jest.Mock).mockRejectedValue(new Error('sesión caída en el paso 4'));
    await expect(core.emitirBhe(registro, '44444444', PARAMS, true)).rejects.toThrow(/paso 4/);
    await expect(core.emitirBhe(registro, '44444444', PARAMS, true)).rejects.toBeInstanceOf(LimitacionConocida);
    expect(MockScraper.prototype.emitir).toHaveBeenCalledTimes(1);
  });
});
