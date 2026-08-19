import { registrarRutasRcv } from '../../../src/rest/rutas/rcv';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/rcv';

jest.mock('../../../src/core/rcv');

function armarRouter(registro?: RegistroSesiones<any>) {
  const rutas = new Map<string, Function>();
  const registroFinal = registro ?? ({ olvidar: jest.fn() } as unknown as RegistroSesiones<any>);
  registrarRutasRcv(rutas as any, registroFinal, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasRcv', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra POST /v1/rcv/resumen y POST /v1/rcv/detalle', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual(['POST /v1/rcv/resumen', 'POST /v1/rcv/detalle']);
  });

  it('resumen: body válido llama al core y devuelve {ok:true, ...datos}', async () => {
    (core.resumen as jest.Mock).mockResolvedValue({ filas: [] });
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', clave: 'x', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta).toEqual({ status: 200, body: { ok: true, filas: [] } });
  });

  it('resumen: body inválido devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', clave: 'x', periodo: 'no-es-un-periodo', operacion: 'VENTA' }
    );

    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('resumen: SesionNoIniciada del core se traduce a ERROR (no debería pasar en REST, pero no debe reventar)', async () => {
    (core.resumen as jest.Mock).mockRejectedValue(new Error('No hay sesión iniciada para el RUT 1. Llamá sii_iniciar_sesion primero.'));
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '1', clave: 'x', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta).toEqual({ status: 200, body: { ok: false, error: 'ERROR' } });
  });

  it('descarta la sesión cacheada del RUT (registro.olvidar) para no reusarla con una clave distinta', async () => {
    (core.resumen as jest.Mock).mockResolvedValue({ filas: [] });
    const olvidar = jest.fn();
    const registro = { olvidar } as unknown as RegistroSesiones<any>;
    const rutas = armarRouter(registro);

    await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', clave: 'x', periodo: '202607', operacion: 'VENTA' }
    );

    expect(olvidar).toHaveBeenCalledWith('11.111.111-1');
  });
});
