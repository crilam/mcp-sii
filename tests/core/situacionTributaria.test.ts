import { situacionTributaria, limpiarCacheSituacionTributaria } from '../../src/core/situacionTributaria';
import { RecursoNoEncontrado } from '../../src/erroresConsulta';
import * as scraper from '../../src/scrapers/situacionTributaria';

jest.mock('../../src/scrapers/situacionTributaria');

const consultar = scraper.consultarSituacionTributaria as jest.Mock;
const SITUACION = { rut: '22222222-2', razonSocial: 'EMPRESA SPA' } as never;

describe('caché de situacionTributaria', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    limpiarCacheSituacionTributaria();
  });

  // El punto del caché: esta consulta le pega dos veces a zeus.sii.cl (captcha
  // más informe) sin credencial que la limite del lado del SII, y el dato casi
  // no cambia. Sin caché, repetir el mismo RUT martilla un portal ajeno.
  it('la segunda consulta del mismo RUT no vuelve al SII', async () => {
    consultar.mockResolvedValue(SITUACION);

    const a = await situacionTributaria('22222222-2');
    const b = await situacionTributaria('22222222-2');

    expect(a).toBe(b);
    expect(consultar).toHaveBeenCalledTimes(1);
  });

  // "22.222.222-2", "22222222-2" y "222222222" son el mismo contribuyente: si no
  // se normalizara la clave, cada forma de escribirlo pagaría su propia consulta
  // y el caché no serviría de nada con un consumidor que no normaliza.
  it('comparte entrada entre las formas de escribir el mismo RUT', async () => {
    consultar.mockResolvedValue(SITUACION);

    await situacionTributaria('22.222.222-2');
    await situacionTributaria('22222222-2');
    await situacionTributaria('222222222');

    expect(consultar).toHaveBeenCalledTimes(1);
  });

  it('RUTs distintos no comparten entrada', async () => {
    consultar.mockResolvedValue(SITUACION);

    await situacionTributaria('22222222-2');
    await situacionTributaria('77777777-7');

    expect(consultar).toHaveBeenCalledTimes(2);
  });

  // Un fallo puede ser del momento (el portal caído). Cachearlo convertiría un
  // error transitorio en la respuesta de todo el día.
  it('no cachea un fallo transitorio', async () => {
    consultar.mockRejectedValueOnce(new Error('portal caído'));
    consultar.mockResolvedValueOnce(SITUACION);

    await expect(situacionTributaria('22222222-2')).rejects.toThrow('portal caído');
    await expect(situacionTributaria('22222222-2')).resolves.toBe(SITUACION);

    expect(consultar).toHaveBeenCalledTimes(2);
  });

  // Tampoco el "sin datos": un RUT recién inscripto pasa de no tener datos a
  // tenerlos, y ése es justo el caso donde un TTL de un día molestaría.
  it('no cachea un RUT sin datos', async () => {
    consultar.mockRejectedValueOnce(new RecursoNoEncontrado('sin datos'));
    consultar.mockResolvedValueOnce(SITUACION);

    await expect(situacionTributaria('22222222-2')).rejects.toThrow(RecursoNoEncontrado);
    await expect(situacionTributaria('22222222-2')).resolves.toBe(SITUACION);

    expect(consultar).toHaveBeenCalledTimes(2);
  });

  // Un RUT que no se puede partir se consulta igual y falla donde corresponde,
  // sin ocupar una entrada del caché con una clave basura.
  it('no cachea un RUT que no se puede partir', async () => {
    consultar.mockResolvedValue(SITUACION);

    await situacionTributaria('no-es-un-rut');
    await situacionTributaria('no-es-un-rut');

    expect(consultar).toHaveBeenCalledTimes(2);
  });

  it('vencido el TTL vuelve a consultar', async () => {
    consultar.mockResolvedValue(SITUACION);
    const ahora = Date.now();
    const reloj = jest.spyOn(Date, 'now');

    reloj.mockReturnValue(ahora);
    await situacionTributaria('22222222-2');

    // Un día y un milisegundo después.
    reloj.mockReturnValue(ahora + 24 * 60 * 60 * 1000 + 1);
    await situacionTributaria('22222222-2');

    expect(consultar).toHaveBeenCalledTimes(2);
    reloj.mockRestore();
  });

  it('dentro del TTL sigue sirviendo de memoria', async () => {
    consultar.mockResolvedValue(SITUACION);
    const ahora = Date.now();
    const reloj = jest.spyOn(Date, 'now');

    reloj.mockReturnValue(ahora);
    await situacionTributaria('22222222-2');

    reloj.mockReturnValue(ahora + 23 * 60 * 60 * 1000);
    await situacionTributaria('22222222-2');

    expect(consultar).toHaveBeenCalledTimes(1);
    reloj.mockRestore();
  });
});
