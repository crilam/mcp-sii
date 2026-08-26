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

  // El techo evita que el caché sea una fuga de memoria en un servicio de larga
  // vida. Sin cobertura, un refactor que lo quite no lo nota nadie hasta el OOM.
  it('al llenarse desaloja la entrada más antigua', async () => {
    for (let i = 0; i < MAX_ENTRADAS; i++) await uf(1990 + i);
    const llamadas = scraperUf.mock.calls.length;

    // La más antigua sigue en caché mientras no se pase el techo.
    await uf(1990);
    expect(scraperUf).toHaveBeenCalledTimes(llamadas);

    // Una más pasa el techo y desaloja la primera que entró. El año va FUERA del
    // rango que llenó el bucle (1990..1990+MAX): usar uno de adentro lo daba por
    // cacheado y el test medía otra cosa.
    await uf(1900);
    await uf(1990);
    expect(scraperUf).toHaveBeenCalledTimes(llamadas + 2);
  });
});
