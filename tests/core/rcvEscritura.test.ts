import * as core from '../../src/core/rcvEscritura';
import { RcvEscrituraScraper, marcarSeguro } from '../../src/scrapers/rcvEscritura';
import { LimitacionConocida } from '../../src/erroresConsulta';

// Se mockea SÓLO la clase; `marcarSeguro`/`acuseSeguroDeLiberar` quedan reales,
// porque la lógica de idempotencia del core depende de ellas.
jest.mock('../../src/scrapers/rcvEscritura', () => {
  const actual = jest.requireActual('../../src/scrapers/rcvEscritura');
  return { ...actual, RcvEscrituraScraper: jest.fn() };
});

const MockScraper = RcvEscrituraScraper as jest.MockedClass<typeof RcvEscrituraScraper>;
(MockScraper.prototype as any).acusar = jest.fn();
const DOCS = [{ rutEmisor: '22222222-2', tipoDoc: 33, folio: 100 }];

// Ejecutor que corre la fn con una sesión dummy (el scraper está mockeado).
const registro = { ejecutar: (_rut: string, fn: any) => fn({}) } as any;

describe('core.acusar — idempotencia anti-doble-click', () => {
  afterEach(() => { jest.clearAllMocks(); core._resetIdempotencia(); jest.useRealTimers(); });

  // EL bloqueante: dos requests concurrentes idénticos (el doble-click real) NO
  // deben cursar el acto dos veces. La reserva es síncrona, antes del await.
  it('dos acuses concurrentes idénticos cursan una sola vez', async () => {
    let resolver: (v: any) => void;
    (MockScraper.prototype.acusar as jest.Mock).mockImplementation(() => new Promise(r => { resolver = r; }));

    const a = core.acusar(registro, '44444444', DOCS, 'ERM', true);
    const b = core.acusar(registro, '44444444', DOCS, 'ERM', true);
    resolver!({ ejecutado: true, evento: 'ERM', documentos: DOCS, mensaje: 'ok' });

    const res = await Promise.allSettled([a, b]);
    const ok = res.filter(r => r.status === 'fulfilled').length;
    const rechazados = res.filter(r => r.status === 'rejected').length;
    expect(ok).toBe(1);
    expect(rechazados).toBe(1);
    expect(MockScraper.prototype.acusar).toHaveBeenCalledTimes(1);
  });

  // Un error MARCADO seguro (el acto no se cursó) libera la reserva: reintento OK.
  it('un error marcado seguro libera la reserva y el reintento cursa', async () => {
    (MockScraper.prototype.acusar as jest.Mock)
      .mockRejectedValueOnce(marcarSeguro(new Error('evento inválido')))
      .mockResolvedValueOnce({ ejecutado: true, evento: 'ERM', documentos: DOCS, mensaje: 'ok' });

    await expect(core.acusar(registro, '55555555', DOCS, 'ERM', true)).rejects.toThrow(/evento inválido/);
    const r = await core.acusar(registro, '55555555', DOCS, 'ERM', true);
    expect(r.ejecutado).toBe(true);
    expect(MockScraper.prototype.acusar).toHaveBeenCalledTimes(2);
  });

  // EL caso más peligroso: un error SIN marca (ambiguo — el POST pudo cursar, o
  // una capa envolvió el error perdiendo la marca) NO libera la reserva. Fail-safe
  // hacia no duplicar: el reintento inmediato se bloquea.
  it('un error sin marca mantiene la reserva y bloquea el reintento', async () => {
    (MockScraper.prototype.acusar as jest.Mock).mockRejectedValue(new Error('timeout tras el POST'));

    await expect(core.acusar(registro, '77777777', DOCS, 'ERM', true)).rejects.toThrow(/timeout/);
    // Reintento inmediato: rechazado por la reserva, NO vuelve a llamar al SII.
    await expect(core.acusar(registro, '77777777', DOCS, 'ERM', true)).rejects.toBeInstanceOf(LimitacionConocida);
    expect(MockScraper.prototype.acusar).toHaveBeenCalledTimes(1);
  });

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

  // Pasada la ventana, el mismo acuse se puede volver a cursar.
  it('tras vencer la ventana, el mismo acuse se cursa de nuevo', async () => {
    (MockScraper.prototype.acusar as jest.Mock).mockResolvedValue({ ejecutado: true, evento: 'ERM', documentos: DOCS, mensaje: 'ok' });
    const base = 1_000_000;
    const spy = jest.spyOn(Date, 'now');
    spy.mockReturnValue(base);
    await core.acusar(registro, '66666666', DOCS, 'ERM', true);
    // 61 s después: fuera de la ventana de 60 s.
    spy.mockReturnValue(base + 61_000);
    await core.acusar(registro, '66666666', DOCS, 'ERM', true);
    expect(MockScraper.prototype.acusar).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
