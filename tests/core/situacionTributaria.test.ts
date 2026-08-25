import { situacionTributaria, limpiarCacheSituacionTributaria, MAX_ENTRADAS } from '../../src/core/situacionTributaria';
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

    // Igual en contenido pero NO la misma referencia: se devuelve una copia,
    // así un consumidor que mute el resultado no corrompe la entrada del caché
    // para todos los demás durante 24 horas.
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
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
    await expect(situacionTributaria('22222222-2')).resolves.toEqual(SITUACION);

    expect(consultar).toHaveBeenCalledTimes(2);
  });

  // Tampoco el "sin datos": un RUT recién inscripto pasa de no tener datos a
  // tenerlos, y ése es justo el caso donde un TTL de un día molestaría.
  it('no cachea un RUT sin datos', async () => {
    consultar.mockRejectedValueOnce(new RecursoNoEncontrado('sin datos'));
    consultar.mockResolvedValueOnce(SITUACION);

    await expect(situacionTributaria('22222222-2')).rejects.toThrow(RecursoNoEncontrado);
    await expect(situacionTributaria('22222222-2')).resolves.toEqual(SITUACION);

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
  // Sin dedupe, N pedidos concurrentes del mismo RUT abrían N consultas al SII
  // antes de que la primera resolviera: justo el escenario que el caché dice
  // evitar (varios tenants preguntando por la misma empresa a la vez).
  it('N pedidos concurrentes del mismo RUT hacen UNA sola consulta', async () => {
    let resolver: (v: unknown) => void = () => {};
    consultar.mockImplementation(() => new Promise(r => { resolver = r; }));

    const pedidos = [
      situacionTributaria('22222222-2'),
      situacionTributaria('22222222-2'),
      situacionTributaria('22.222.222-2'),
    ];
    resolver(SITUACION);
    const [a, b, c] = await Promise.all(pedidos);

    expect(consultar).toHaveBeenCalledTimes(1);
    expect(a).toEqual(SITUACION);
    expect(b).toEqual(SITUACION);
    expect(c).toEqual(SITUACION);
  });

  // Un fallo no debe quedar pegado para los que vengan después: la promesa en
  // vuelo se borra al asentarse, con éxito o con error.
  it('un fallo concurrente no queda pegado para el pedido siguiente', async () => {
    consultar.mockRejectedValueOnce(new Error('portal caído'));

    await expect(situacionTributaria('22222222-2')).rejects.toThrow('portal caído');

    consultar.mockResolvedValueOnce(SITUACION);
    await expect(situacionTributaria('22222222-2')).resolves.toEqual(SITUACION);
    expect(consultar).toHaveBeenCalledTimes(2);
  });

  // Mutar lo que devuelve la API no puede afectar a la próxima lectura.
  it('mutar el resultado no corrompe la entrada del caché', async () => {
    consultar.mockResolvedValue({ rut: '22222222-2', actividades: [{ codigo: 1 }] } as never);

    const primero = await situacionTributaria('22222222-2') as { actividades: unknown[] };
    primero.actividades.length = 0;
    const segundo = await situacionTributaria('22222222-2') as { actividades: unknown[] };

    expect(segundo.actividades).toHaveLength(1);
  });
  // El caché tiene desalojo FIFO por un techo de entradas. Sin cobertura, un
  // refactor que quite el desalojo convierte el Map en una fuga de memoria
  // silenciosa: el servicio es de larga vida y nadie lo notaría hasta el OOM.
  it('al llenarse desaloja la entrada más antigua', async () => {
    consultar.mockResolvedValue(SITUACION);

    // Claves de CINCO dígitos: `partirRut` las acepta (pide 5 a 9) y no tienen
    // forma de RUT chileno real, que son 7 u 8, así que el chequeo de
    // anonimización no las marca y no hay colisiones entre las 5000. El DV no
    // importa acá: el caché sólo parte la cadena y el módulo 11 se valida en la
    // ruta.
    const rutFicticio = (i: number) => `${10000 + i}-1`;
    for (let i = 0; i < MAX_ENTRADAS; i++) {
      await situacionTributaria(rutFicticio(i));
    }
    const llamadasIniciales = consultar.mock.calls.length;

    // La primera sigue en caché mientras no se pase el techo.
    await situacionTributaria(rutFicticio(0));
    expect(consultar).toHaveBeenCalledTimes(llamadasIniciales);

    // Una entrada más pasa el techo y desaloja la más antigua. Ojo: el desalojo
    // es FIFO por orden de INSERCIÓN, no LRU — haberla leído recién no la
    // rejuvenece, así que la que sale es igual la primera que entró.
    await situacionTributaria('99999-1');
    expect(consultar).toHaveBeenCalledTimes(llamadasIniciales + 1);

    // Y la desalojada vuelve a costar una consulta, que es la prueba de que
    // realmente salió del caché.
    await situacionTributaria(rutFicticio(0));
    expect(consultar).toHaveBeenCalledTimes(llamadasIniciales + 2);

    // Mientras la entrada más NUEVA sigue saliendo de memoria: con FIFO, cada
    // inserción saca a la más vieja, así que la reciente es la que sobrevive.
    await situacionTributaria(rutFicticio(MAX_ENTRADAS - 1));
    expect(consultar).toHaveBeenCalledTimes(llamadasIniciales + 2);
  });
});
