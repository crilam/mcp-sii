import * as core from '../../src/core/vehiculos';
import * as scraper from '../../src/scrapers/vehiculos';
import { RecursoNoEncontrado } from '../../src/erroresConsulta';

jest.mock('../../src/scrapers/vehiculos');
const planillaMock = scraper.planilla as jest.Mock;

const fila = (o: Partial<scraper.TasacionVehiculo>): scraper.TasacionVehiculo => ({
  codigoSii: 'X', anioFabricacion: 2020, tipo: 'Sedán', marca: 'M', modelo: 'A', version: 'V',
  puertas: null, cilindrada: null, potencia: null, combustible: '', transmision: '', marchas: null,
  traccion: '', pais: '', equipamiento: '', carga: null, pasajeros: null, tasacion: 1, permiso: 1,
  observacion: '', ...o,
});

const PLANILLA: scraper.PlanillaTasacion = {
  anio: 2026, categoria: 'liviano',
  filas: [
    fila({ codigoSii: 'CB1', anioFabricacion: 2018, tipo: 'Cabriolet', marca: 'MARCA UNO', modelo: 'MODELO A', version: 'V1', tasacion: 100 }),
    fila({ codigoSii: 'CB1', anioFabricacion: 2019, tipo: 'Cabriolet', marca: 'MARCA UNO', modelo: 'MODELO A', version: 'V1', tasacion: 110 }),
    fila({ codigoSii: 'SD2', anioFabricacion: 2020, tipo: 'Sedán', marca: 'MARCA UNO', modelo: 'MODELO B', version: 'GL', tasacion: 50 }),
    fila({ codigoSii: 'SV3', anioFabricacion: 2021, tipo: 'Suv', marca: 'MARCA DOS', modelo: 'MODELO C', version: '4WD', tasacion: 200 }),
  ],
  equipamiento: [{ sigla: 'AA', descripcion: 'Aire Acondicionado' }],
};

describe('core/vehiculos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    core.limpiarCacheVehiculos();
    planillaMock.mockResolvedValue(PLANILLA);
  });

  // Una planilla son ~7 MB y ~80.000 filas: bajarla por consulta es absurdo y es
  // el patrón que el SII castiga. Todas las consultas de un año salen de la
  // misma bajada.
  it('baja la planilla una vez y responde todas las consultas de memoria', async () => {
    await core.tipos({ anio: 2026, categoria: 'liviano' });
    await core.marcas({ anio: 2026, categoria: 'liviano' });
    await core.modelos({ anio: 2026, categoria: 'liviano', marca: 'MARCA UNO' });

    expect(planillaMock).toHaveBeenCalledTimes(1);
  });

  it('años o categorías distintas son planillas distintas', async () => {
    await core.tipos({ anio: 2026, categoria: 'liviano' });
    await core.tipos({ anio: 2026, categoria: 'pesado' });
    await core.tipos({ anio: 2025, categoria: 'liviano' });

    expect(planillaMock).toHaveBeenCalledTimes(3);
  });

  it('tipos y marcas vienen sin repetir y ordenados', async () => {
    await expect(core.tipos({ anio: 2026, categoria: 'liviano' })).resolves.toEqual(['Cabriolet', 'Sedán', 'Suv']);
    await expect(core.marcas({ anio: 2026, categoria: 'liviano' })).resolves.toEqual(['MARCA DOS', 'MARCA UNO']);
    await expect(core.marcas({ anio: 2026, categoria: 'liviano', tipo: 'suv' })).resolves.toEqual(['MARCA DOS']);
  });

  it('modelos agrupa versiones y años de fabricación por modelo', async () => {
    await expect(core.modelos({ anio: 2026, categoria: 'liviano', marca: 'marca uno' })).resolves.toEqual([
      { modelo: 'MODELO A', versiones: ['V1'], aniosFabricacion: [2018, 2019] },
      { modelo: 'MODELO B', versiones: ['GL'], aniosFabricacion: [2020] },
    ]);
  });

  // Una lista vacía se leería como "marca sin modelos", cosa que no existe en
  // la planilla: una marca desconocida se dice.
  it('una marca inexistente es NO_ENCONTRADO', async () => {
    await expect(core.modelos({ anio: 2026, categoria: 'liviano', marca: 'NADIE' }))
      .rejects.toBeInstanceOf(RecursoNoEncontrado);
  });

  // Un modelo tiene una fila por año de fabricación y por versión: elegir una
  // acá sería adivinar cuál quería el consumidor.
  it('tasacion devuelve TODAS las filas que coinciden', async () => {
    const r = await core.tasacion({ anio: 2026, categoria: 'liviano', marca: 'MARCA UNO', modelo: 'MODELO A' });
    expect(r.map(f => f.tasacion)).toEqual([100, 110]);

    const una = await core.tasacion({ anio: 2026, categoria: 'liviano', marca: 'MARCA UNO', modelo: 'MODELO A', anioFabricacion: 2019 });
    expect(una.map(f => f.tasacion)).toEqual([110]);
  });

  it('tasacion por código SII no necesita marca ni modelo', async () => {
    const r = await core.tasacion({ anio: 2026, categoria: 'liviano', codigoSii: 'sv3' });
    expect(r).toHaveLength(1);
    expect(r[0].marca).toBe('MARCA DOS');
  });

  it('tasacion sin código ni marca+modelo es un error de entrada', async () => {
    await expect(core.tasacion({ anio: 2026, categoria: 'liviano', marca: 'MARCA UNO' }))
      .rejects.toThrow(/codigo_sii, o marca y modelo/);
    expect(planillaMock).not.toHaveBeenCalled();
  });

  it('un vehículo que no existe es NO_ENCONTRADO', async () => {
    await expect(core.tasacion({ anio: 2026, categoria: 'liviano', codigoSii: 'ZZ9' }))
      .rejects.toBeInstanceOf(RecursoNoEncontrado);
  });

  // Un fallo puede ser del momento (portal caído, corte por volumen): guardarlo
  // convertiría un problema de un rato en la respuesta de todo el día.
  it('no cachea un fallo', async () => {
    planillaMock.mockRejectedValueOnce(new Error('portal caído'));

    await expect(core.tipos({ anio: 2026, categoria: 'liviano' })).rejects.toThrow('portal caído');
    await expect(core.tipos({ anio: 2026, categoria: 'liviano' })).resolves.toHaveLength(3);
    expect(planillaMock).toHaveBeenCalledTimes(2);
  });

  it('consultas concurrentes del mismo año comparten una sola bajada', async () => {
    let resolver!: (v: scraper.PlanillaTasacion) => void;
    planillaMock.mockReturnValueOnce(new Promise(r => { resolver = r; }));

    const todas = Promise.all([
      core.tipos({ anio: 2026, categoria: 'liviano' }),
      core.marcas({ anio: 2026, categoria: 'liviano' }),
    ]);
    resolver(PLANILLA);
    await todas;

    expect(planillaMock).toHaveBeenCalledTimes(1);
  });

  it('equipamiento devuelve el diccionario de siglas', async () => {
    await expect(core.equipamiento({ anio: 2026, categoria: 'liviano' }))
      .resolves.toEqual([{ sigla: 'AA', descripcion: 'Aire Acondicionado' }]);
  });
});
