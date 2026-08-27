import { uf, dolar, limpiarCacheIndicadores, MAX_ENTRADAS } from '../../src/core/indicadores';
import * as scraper from '../../src/scrapers/indicadores';

jest.mock('../../src/scrapers/indicadores');

const scraperUf = scraper.uf as jest.Mock;
const scraperDolar = scraper.dolar as jest.Mock;
const VALORES = [{ mes: 1, dia: 1, valor: 38384.41 }];

describe('caché de indicadores', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    limpiarCacheIndicadores();
    scraperUf.mockResolvedValue(VALORES);
    scraperDolar.mockResolvedValue(VALORES);
  });
  afterEach(() => jest.restoreAllMocks());

  // Cada consulta baja una página ENTERA del SII para devolver un valor, y el SII
  // corta por volumen. Sin caché, convertir cien montos a UF baja cien veces la
  // misma tabla.
  it('la segunda consulta del mismo año no vuelve al SII', async () => {
    await uf(2025);
    await uf(2025);

    expect(scraperUf).toHaveBeenCalledTimes(1);
  });

  it('años distintos no comparten entrada', async () => {
    await uf(2025);
    await uf(2024);

    expect(scraperUf).toHaveBeenCalledTimes(2);
  });

  // La clave incluye el indicador: si sólo fuera el año, pedir el dólar de 2025
  // después de la UF de 2025 devolvería la tabla de la UF.
  it('indicadores distintos del mismo año no comparten entrada', async () => {
    await uf(2025);
    await dolar(2025);

    expect(scraperUf).toHaveBeenCalledTimes(1);
    expect(scraperDolar).toHaveBeenCalledTimes(1);
  });

  // Un año CERRADO no cambia nunca: el valor de la UF del 3 de marzo de 2020 es
  // el que es. Se cachea sin vencimiento.
  it('un año ya cerrado se cachea indefinidamente', async () => {
    const reloj = jest.spyOn(Date, 'now');
    const base = new Date('2026-08-26T12:00:00Z').getTime();

    reloj.mockReturnValue(base);
    await uf(2025);

    // Un año entero después.
    reloj.mockReturnValue(base + 365 * 24 * 60 * 60 * 1000);
    await uf(2025);

    expect(scraperUf).toHaveBeenCalledTimes(1);
  });

  // El año EN CURSO sí cambia: el SII le agrega días. Se revisa cada seis horas.
  it('el año en curso se vuelve a consultar pasado el TTL', async () => {
    const reloj = jest.spyOn(Date, 'now');
    const base = new Date('2026-08-26T12:00:00Z').getTime();

    reloj.mockReturnValue(base);
    await uf(2026);

    // Cinco horas: todavía sirve de memoria.
    reloj.mockReturnValue(base + 5 * 60 * 60 * 1000);
    await uf(2026);
    expect(scraperUf).toHaveBeenCalledTimes(1);

    // Siete horas: vuelve al SII.
    reloj.mockReturnValue(base + 7 * 60 * 60 * 1000);
    await uf(2026);
    expect(scraperUf).toHaveBeenCalledTimes(2);
  });

  // Un año futuro tampoco se cachea para siempre: el SII puede publicarlo más
  // adelante, y una entrada eterna diría "no hay datos" por el resto del proceso.
  it('un año futuro no se cachea indefinidamente', async () => {
    const reloj = jest.spyOn(Date, 'now');
    const base = new Date('2026-08-26T12:00:00Z').getTime();

    reloj.mockReturnValue(base);
    await uf(2027);

    reloj.mockReturnValue(base + 7 * 60 * 60 * 1000);
    await uf(2027);

    expect(scraperUf).toHaveBeenCalledTimes(2);
  });

  // Un fallo puede ser del momento —el portal caído, un corte por volumen— y
  // guardarlo convertiría un problema de un rato en la respuesta de todo el día.
  it('no cachea un fallo', async () => {
    scraperUf.mockRejectedValueOnce(new Error('portal caído'));

    await expect(uf(2025)).rejects.toThrow('portal caído');
    await expect(uf(2025)).resolves.toEqual(VALORES);

    expect(scraperUf).toHaveBeenCalledTimes(2);
  });

  // Sin deduplicar en vuelo, diez conversiones a UF lanzadas juntas bajan diez
  // veces la misma página. Y el SII corta por volumen justo por eso.
  it('consultas concurrentes del mismo año comparten una sola bajada', async () => {
    let resolver!: (v: unknown) => void;
    scraperUf.mockReturnValueOnce(new Promise(r => { resolver = r; }));

    const todas = Promise.all([uf(2025), uf(2025), uf(2025)]);
    resolver(VALORES);

    expect(await todas).toEqual([VALORES, VALORES, VALORES]);
    expect(scraperUf).toHaveBeenCalledTimes(1);
  });

  // Es el único dominio que NO pasa por la ColaPorClave de los tenants: sin la
  // cola propia, varios tenants pidiendo años distintos barren el portal en
  // paralelo — el patrón que ya bloqueó el RCV.
  it('no consulta dos años en paralelo contra el portal', async () => {
    let enVuelo = 0;
    let maximo = 0;
    scraperUf.mockImplementation(async () => {
      enVuelo++;
      maximo = Math.max(maximo, enVuelo);
      await new Promise(r => setImmediate(r));
      enVuelo--;
      return VALORES;
    });

    await Promise.all([uf(2020), uf(2021), uf(2022), uf(2023)]);

    expect(scraperUf).toHaveBeenCalledTimes(4);
    expect(maximo).toBe(1);
  });

  // Un fallo no queda cacheado, pero quien ya está colgado de esa promesa tiene
  // que recibir el error y no una promesa huérfana.
  it('un fallo llega a todos los que esperaban y no queda en caché', async () => {
    scraperUf.mockRejectedValueOnce(new Error('portal caído'));

    const a = uf(2025);
    const b = uf(2025);
    await expect(a).rejects.toThrow('portal caído');
    await expect(b).rejects.toThrow('portal caído');

    await expect(uf(2025)).resolves.toEqual(VALORES);
    expect(scraperUf).toHaveBeenCalledTimes(2);
  });

  // El desalojo es LRU y no FIFO: el año en curso es de los primeros que entran y
  // el que más se repide, así que un FIFO puro botaba justo la entrada más usada.
  it('un acierto renueva la antigüedad de la entrada', async () => {
    for (let i = 0; i < MAX_ENTRADAS; i++) await uf(1990 + i);
    // Toca la más antigua: pasa a ser la más reciente.
    await uf(1990);
    const llamadas = scraperUf.mock.calls.length;

    // La nueva entrada desaloja a 1991, que ahora es la más vieja, no a 1990.
    await uf(1900);
    await uf(1990);
    expect(scraperUf).toHaveBeenCalledTimes(llamadas + 1);
    await uf(1991);
    expect(scraperUf).toHaveBeenCalledTimes(llamadas + 2);
  });

  // El techo evita que el caché sea una fuga de memoria en un servicio de larga
  // vida. Sin cobertura, un refactor que lo quite no lo nota nadie hasta el OOM.
  // El QUÉ se desaloja lo cubre el test de LRU de arriba; acá sólo que se desaloja.
  it('al llenarse desaloja alguna entrada en vez de crecer sin techo', async () => {
    for (let i = 0; i < MAX_ENTRADAS; i++) await uf(1990 + i);
    const llamadas = scraperUf.mock.calls.length;

    // Una entrada nueva —el año va FUERA del rango que llenó el bucle— fuerza el
    // desalojo, y entonces alguno de los años ya pedidos vuelve a consultarse.
    await uf(1900);
    for (let i = 0; i < MAX_ENTRADAS; i++) await uf(1990 + i);

    expect(scraperUf.mock.calls.length).toBeGreaterThan(llamadas + 1);
  });
});
