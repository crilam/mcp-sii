import { registrarRutasActividadesEconomicas } from '../../../src/rest/rutas/actividadesEconomicas';
import { RutaHandler } from '../../../src/rest/rutas/comun';
import * as core from '../../../src/core/actividadesEconomicas';

jest.mock('../../../src/core/actividadesEconomicas');

function armar() {
  const rutas = new Map<string, RutaHandler>();
  registrarRutasActividadesEconomicas(rutas);
  return rutas;
}

describe('registrarRutasActividadesEconomicas', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 3 rutas bajo /v1/contribuyentes', () => {
    expect(new Set(armar().keys())).toEqual(new Set([
      'POST /v1/contribuyentes/actividades-economicas',
      'POST /v1/contribuyentes/actividad-economica',
      'POST /v1/contribuyentes/verificar-rut',
    ]));
  });

  // Sin rut ni credencial, como toda tabla pública. Y los filtros snake_case del
  // body llegan al core con sus nombres.
  it('actividades-economicas traduce los filtros y envuelve la lista en datos', async () => {
    (core.actividades as jest.Mock).mockResolvedValue([{ codigo: '011101' }]);

    const r = await armar().get('POST /v1/contribuyentes/actividades-economicas')!({
      categoria: '1', afecta_iva: true, texto: 'trigo',
    });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, datos: [{ codigo: '011101' }] });
    expect(core.actividades).toHaveBeenCalledWith({ categoria: '1', afectaIva: true, texto: 'trigo' });
  });

  it('actividad-economica exige seis dígitos', async () => {
    const r = await armar().get('POST /v1/contribuyentes/actividad-economica')!({ codigo: '123' });

    expect(r.status).toBe(400);
    expect(core.actividad).not.toHaveBeenCalled();
  });

  // El verificador no toca el SII: el resultado es un objeto, y se spreadea.
  it('verificar-rut devuelve el veredicto en el body', async () => {
    (core.verificarRut as jest.Mock).mockReturnValue({ rut: '11111111-1', valido: true, cuerpo: '11111111', dv: '1' });

    const r = await armar().get('POST /v1/contribuyentes/verificar-rut')!({ rut: '11.111.111-1' });

    expect(r.body).toEqual({ ok: true, rut: '11111111-1', valido: true, cuerpo: '11111111', dv: '1' });
  });
});
