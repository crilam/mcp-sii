import * as coreObs from '../../src/core/bheObservacion';
import * as coreEmail from '../../src/core/bheEmail';
import { BheObservacionScraper } from '../../src/scrapers/bheObservacion';
import { BheEmailScraper } from '../../src/scrapers/bheEmail';
import { LimitacionConocida } from '../../src/erroresConsulta';

jest.mock('../../src/scrapers/bheObservacion', () => {
  const actual = jest.requireActual('../../src/scrapers/bheObservacion');
  return { ...actual, BheObservacionScraper: jest.fn() };
});
jest.mock('../../src/scrapers/bheEmail', () => {
  const actual = jest.requireActual('../../src/scrapers/bheEmail');
  return { ...actual, BheEmailScraper: jest.fn() };
});

const obsMock = jest.fn();
const emailMock = jest.fn();
(BheObservacionScraper as jest.MockedClass<typeof BheObservacionScraper>).prototype.observar = obsMock;
(BheEmailScraper as jest.MockedClass<typeof BheEmailScraper>).prototype.enviar = emailMock;

const registro = { ejecutar: (_r: string, fn: (s: unknown) => unknown) => fn({}) } as never;

describe('core.observarBhe — idempotencia', () => {
  afterEach(() => { jest.clearAllMocks(); coreObs.ventanaObservacion._reset(); });

  it('la previsualización repetida no se bloquea', async () => {
    obsMock.mockResolvedValue({ observada: false });
    await coreObs.observarBhe(registro, '11111111', 2026, 8, 4514, 1, false);
    await coreObs.observarBhe(registro, '11111111', 2026, 8, 4514, 1, false);
    expect(obsMock).toHaveBeenCalledTimes(2);
  });

  it('el MISMO folio con confirmar:true dos veces se bloquea la segunda; otro folio no', async () => {
    obsMock.mockResolvedValue({ observada: true });
    await coreObs.observarBhe(registro, '22222222', 2026, 8, 4514, 1, true);
    await expect(coreObs.observarBhe(registro, '22222222', 2026, 8, 4514, 1, true)).rejects.toBeInstanceOf(LimitacionConocida);
    await coreObs.observarBhe(registro, '22222222', 2026, 8, 4520, 1, true);
    expect(obsMock).toHaveBeenCalledTimes(2);
  });
});

describe('core.enviarBheEmail — idempotencia', () => {
  afterEach(() => { jest.clearAllMocks(); coreEmail.ventanaEmail._reset(); });

  it('la previsualización repetida no se bloquea', async () => {
    emailMock.mockResolvedValue({ enviado: false });
    await coreEmail.enviarBheEmail(registro, '11111111', 'CB1', undefined, false);
    await coreEmail.enviarBheEmail(registro, '11111111', 'CB1', undefined, false);
    expect(emailMock).toHaveBeenCalledTimes(2);
  });

  it('el MISMO envío con confirmar:true dos veces se bloquea; a otro email no', async () => {
    emailMock.mockResolvedValue({ enviado: true });
    await coreEmail.enviarBheEmail(registro, '22222222', 'CB1', 'a@ejemplo.cl', true);
    await expect(coreEmail.enviarBheEmail(registro, '22222222', 'CB1', 'a@ejemplo.cl', true)).rejects.toBeInstanceOf(LimitacionConocida);
    await coreEmail.enviarBheEmail(registro, '22222222', 'CB1', 'otro@ejemplo.cl', true);
    expect(emailMock).toHaveBeenCalledTimes(2);
  });
});
