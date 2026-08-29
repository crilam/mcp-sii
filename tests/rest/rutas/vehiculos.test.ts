import { registrarRutasVehiculos } from '../../../src/rest/rutas/vehiculos';
import { RutaHandler } from '../../../src/rest/rutas/comun';
import * as core from '../../../src/core/vehiculos';

jest.mock('../../../src/core/vehiculos');

function armar() {
  const rutas = new Map<string, RutaHandler>();
  registrarRutasVehiculos(rutas);
  return rutas;
}

describe('registrarRutasVehiculos', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 5 rutas bajo /v1/vehiculos', () => {
    expect(new Set(armar().keys())).toEqual(new Set([
      'POST /v1/vehiculos/tipos', 'POST /v1/vehiculos/marcas', 'POST /v1/vehiculos/modelos',
      'POST /v1/vehiculos/tasacion', 'POST /v1/vehiculos/equipamiento',
    ]));
  });

  // Como indicadores: es una familia SIN rut ni credencial. Si alguien le
  // agregara `conCredencial`, un consumidor tendría que mandar una clave para
  // leer una planilla pública.
  it('responde sin rut ni credencial y envuelve la lista en datos', async () => {
    (core.tipos as jest.Mock).mockResolvedValue(['Sedán']);

    const r = await armar().get('POST /v1/vehiculos/tipos')!({ anio: 2026 });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, datos: ['Sedán'] });
    // La categoría por defecto es liviano.
    expect(core.tipos).toHaveBeenCalledWith({ anio: 2026, categoria: 'liviano' });
  });

  it('un año anterior a 2020 es 400: el SII no publica XLSX antes', async () => {
    const r = await armar().get('POST /v1/vehiculos/marcas')!({ anio: 2019 });

    expect(r.status).toBe(400);
    expect(core.marcas).not.toHaveBeenCalled();
  });

  it('tasacion traduce snake_case a lo que espera el core', async () => {
    (core.tasacion as jest.Mock).mockResolvedValue([]);

    await armar().get('POST /v1/vehiculos/tasacion')!({
      anio: 2026, categoria: 'pesado', codigo_sii: 'AR1', anio_fabricacion: 2020,
    });

    expect(core.tasacion).toHaveBeenCalledWith({
      anio: 2026, categoria: 'pesado', codigoSii: 'AR1', marca: undefined, modelo: undefined,
      version: undefined, anioFabricacion: 2020,
    });
  });

  // El 400 tiene que decir qué falta: un ERROR del core diría "algo salió mal".
  it('tasacion sin codigo_sii ni marca+modelo es 400 con el motivo', async () => {
    const r = await armar().get('POST /v1/vehiculos/tasacion')!({ anio: 2026, marca: 'X' });

    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/codigo_sii, o marca y modelo/);
    expect(core.tasacion).not.toHaveBeenCalled();
  });

  it('modelos exige la marca', async () => {
    const r = await armar().get('POST /v1/vehiculos/modelos')!({ anio: 2026 });

    expect(r.status).toBe(400);
    expect(core.modelos).not.toHaveBeenCalled();
  });
});
