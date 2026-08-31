import * as core from '../../src/core/rcvEscritura';
import { RcvEscrituraScraper } from '../../src/scrapers/rcvEscritura';
import { LimitacionConocida } from '../../src/erroresConsulta';

jest.mock('../../src/scrapers/rcvEscritura');

const MockScraper = RcvEscrituraScraper as jest.MockedClass<typeof RcvEscrituraScraper>;
const DOCS = [{ rutEmisor: '22222222-2', tipoDoc: 33, folio: 100 }];

// Ejecutor que corre la fn con una sesión dummy (el scraper está mockeado).
const registro = { ejecutar: (_rut: string, fn: any) => fn({}) } as any;

describe('core.acusar — idempotencia anti-doble-click', () => {
  afterEach(() => jest.clearAllMocks());

  it('un acuse ejecutado dos veces en la ventana se rechaza la segunda vez', async () => {
    (MockScraper.prototype.acusar as jest.Mock).mockResolvedValue({ ejecutado: true, evento: 'ERM', documentos: DOCS, mensaje: 'ok' });

    const uno = await core.acusar(registro, '11111111', DOCS, 'ERM', true);
    expect(uno.ejecutado).toBe(true);

    // Segunda llamada idéntica: no vuelve a cursar contra el SII.
    await expect(core.acusar(registro, '11111111', DOCS, 'ERM', true)).rejects.toBeInstanceOf(LimitacionConocida);
    expect(MockScraper.prototype.acusar).toHaveBeenCalledTimes(1);
  });

  it('una SIMULACIÓN repetida NO se bloquea (no muta nada)', async () => {
    (MockScraper.prototype.acusar as jest.Mock).mockResolvedValue({ ejecutado: false, evento: 'ERM', documentos: DOCS, mensaje: 'sim' });

    await core.acusar(registro, '22222222', DOCS, 'ERM', false);
    await core.acusar(registro, '22222222', DOCS, 'ERM', false);
    expect(MockScraper.prototype.acusar).toHaveBeenCalledTimes(2);
  });

  it('documentos distintos no comparten la traba de idempotencia', async () => {
    (MockScraper.prototype.acusar as jest.Mock).mockResolvedValue({ ejecutado: true, evento: 'ERM', documentos: DOCS, mensaje: 'ok' });

    await core.acusar(registro, '33333333', DOCS, 'ERM', true);
    // Otro folio: es otro acto, se cursa.
    await core.acusar(registro, '33333333', [{ rutEmisor: '22222222-2', tipoDoc: 33, folio: 999 }], 'ERM', true);
    expect(MockScraper.prototype.acusar).toHaveBeenCalledTimes(2);
  });
});
