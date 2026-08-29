import * as core from '../../src/core/indicadores';
import * as scraper from '../../src/scrapers/indicadores';
import { ServicioOcupado } from '../../src/erroresConsulta';

// Hallazgo del code review del PR #63: la cola contra el portal es de un solo
// turno y no tenía tope. El `AbortSignal.timeout` de la bajada cubre la
// conexión, no la espera en cola, así que una ráfaga de años nuevos dejaba a
// los demás colgados minutos sin error — que del lado del consumidor se ve
// igual que un servicio caído.
jest.mock('../../src/scrapers/indicadores');

const uf = scraper.uf as jest.MockedFunction<typeof scraper.uf>;

beforeEach(() => {
  core.limpiarCacheIndicadores();
  uf.mockReset();
});

describe('tope de la cola de indicadores', () => {
  it('rechaza rápido cuando ya hay demasiadas esperando, en vez de encolar sin límite', async () => {
    // El portal lento es cuando la cola crece, así que las bajadas se dejan sin
    // resolver. Se guardan sus `resolve` para liberarlas al final: la cola es un
    // singleton de módulo, y dejarlas colgadas bloquea a los tests que siguen —
    // que es exactamente lo que pasa en producción si una bajada no termina, y
    // por eso el tope existe.
    // Una compuerta compartida y no un `resolve` por llamada: la cola serializa,
    // así que sólo la PRIMERA bajada llega a ejecutarse y las demás esperan su
    // turno sin invocar al scraper. Juntar los `resolve` de las que corrieron
    // liberaría una sola y el resto quedaría colgado igual.
    let abrir!: () => void;
    const compuerta = new Promise<void>(resolve => { abrir = resolve; });
    uf.mockImplementation(async () => { await compuerta; return []; });

    // Años distintos para que cada una sea una entrada de caché distinta y
    // ninguna comparta la promesa en vuelo de otra.
    const enCurso = Array.from({ length: core.MAX_EN_COLA }, (_, i) => core.uf(1990 + i));
    enCurso.forEach(p => p.catch(() => { /* liberadas al final */ }));

    await expect(core.uf(2050)).rejects.toBeInstanceOf(ServicioOcupado);

    abrir();
    await Promise.allSettled(enCurso);
  });

  // El tope no puede convertirse en un rechazo permanente: cuando las que
  // estaban esperando terminan, el servicio vuelve a aceptar.
  it('vuelve a aceptar cuando la cola se descarga', async () => {
    uf.mockResolvedValue([{ mes: 1, dia: 1, valor: 39000 }]);

    for (let i = 0; i < core.MAX_EN_COLA + 3; i++) {
      await expect(core.uf(1990 + i)).resolves.toHaveLength(1);
    }
  });

  // Un acierto de caché no toca el portal, así que no debe consumir cupo: si lo
  // contara, un consumidor que repite el mismo año se auto-bloquearía.
  it('el acierto de caché no ocupa lugar en la cola', async () => {
    uf.mockResolvedValue([{ mes: 1, dia: 1, valor: 39000 }]);
    await core.uf(2025);

    const repetidas = await Promise.all(
      Array.from({ length: core.MAX_EN_COLA * 2 }, () => core.uf(2025)));

    expect(repetidas).toHaveLength(core.MAX_EN_COLA * 2);
    expect(uf).toHaveBeenCalledTimes(1);
  });
});
