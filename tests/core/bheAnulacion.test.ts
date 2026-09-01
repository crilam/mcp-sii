import * as core from '../../src/core/bheAnulacion';
import { BheAnulacionScraper } from '../../src/scrapers/bheAnulacion';
import { LimitacionConocida } from '../../src/erroresConsulta';
import { marcarSeguro } from '../../src/idempotenciaEscritura';

jest.mock('../../src/scrapers/bheAnulacion', () => {
  const actual = jest.requireActual('../../src/scrapers/bheAnulacion');
  return { ...actual, BheAnulacionScraper: jest.fn() };
});

const MockScraper = BheAnulacionScraper as jest.MockedClass<typeof BheAnulacionScraper>;
(MockScraper.prototype as unknown as { anular: jest.Mock }).anular = jest.fn();
const anularMock = MockScraper.prototype.anular as jest.Mock;

const registro = { ejecutar: (_r: string, fn: (s: unknown) => unknown) => fn({}) } as never;

describe('core.anularBhe — idempotencia', () => {
  afterEach(() => { jest.clearAllMocks(); core.ventanaAnulacion._reset(); });

  it('la previsualización repetida no se bloquea (no anula)', async () => {
    anularMock.mockResolvedValue({ anulada: false });
    await core.anularBhe(registro, '11111111', 341, 3, false);
    await core.anularBhe(registro, '11111111', 341, 3, false);
    expect(anularMock).toHaveBeenCalledTimes(2);
  });

  it('el MISMO folio con confirmar:true dos veces se bloquea la segunda', async () => {
    anularMock.mockResolvedValue({ anulada: true, folio: 341 });
    await core.anularBhe(registro, '22222222', 341, 3, true);
    await expect(core.anularBhe(registro, '22222222', 341, 3, true)).rejects.toBeInstanceOf(LimitacionConocida);
    expect(anularMock).toHaveBeenCalledTimes(1);
  });

  it('folios DISTINTOS con confirmar:true no se estorban', async () => {
    anularMock.mockResolvedValue({ anulada: true });
    await core.anularBhe(registro, '22222222', 341, 3, true);
    await core.anularBhe(registro, '22222222', 342, 3, true);
    expect(anularMock).toHaveBeenCalledTimes(2);
  });

  it('el mismo folio con el rut en otro formato cae en la MISMA reserva', async () => {
    anularMock.mockResolvedValue({ anulada: true });
    await core.anularBhe(registro, '11.111.111-1', 341, 3, true);
    await expect(core.anularBhe(registro, '11111111-1', 341, 3, true)).rejects.toBeInstanceOf(LimitacionConocida);
    expect(anularMock).toHaveBeenCalledTimes(1);
  });

  it('un rechazo marcado seguro libera y el reintento entra', async () => {
    anularMock
      .mockRejectedValueOnce(marcarSeguro(new Error('rechazo del SII')))
      .mockResolvedValueOnce({ anulada: true, folio: 341 });
    await expect(core.anularBhe(registro, '33333333', 341, 3, true)).rejects.toThrow(/rechazo/);
    await core.anularBhe(registro, '33333333', 341, 3, true);
    expect(anularMock).toHaveBeenCalledTimes(2);
  });

  it('un error SIN marca (paso 3 ambiguo) mantiene la reserva', async () => {
    anularMock.mockRejectedValue(new Error('sesión caída en el paso que anula'));
    await expect(core.anularBhe(registro, '44444444', 341, 3, true)).rejects.toThrow(/paso/);
    await expect(core.anularBhe(registro, '44444444', 341, 3, true)).rejects.toBeInstanceOf(LimitacionConocida);
    expect(anularMock).toHaveBeenCalledTimes(1);
  });
});
