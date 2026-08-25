import { registrarRutasRcv } from '../../../src/rest/rutas/rcv';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/rcv';

jest.mock('../../../src/core/rcv');

function armarRouter() {
  const rutas = new Map<string, Function>();
  // core.resumen/detalle están mockeados en este archivo, así que nunca
  // invocan el EjecutorSesion que arma la ruta — no hace falta que `registro`
  // implemente nada real acá. La atomicidad guardar/crear/fn/borrar contra
  // dos requests concurrentes al mismo RUT se prueba a nivel de
  // RegistroSesiones.ejecutarPassThrough, en tests/registroSesiones.test.ts.
  registrarRutasRcv(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
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
      { rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta).toEqual({ status: 200, body: { ok: true, filas: [] } });
  });

  it('resumen: certificado_base64 vacío devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', certificado_base64: '', certificado_password: 'yyy', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toBe('BAD_REQUEST');
    // El detalle es la mejora que trae `conCredencial`: antes estas rutas
    // devolvían BAD_REQUEST pelado y el integrador no sabía qué campo falló.
    expect(respuesta.body.detalle).toBeTruthy();
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('resumen: certificado_base64 con caracteres no-base64 devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', certificado_base64: '!!!no-base64!!!', certificado_password: 'yyy', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toBe('BAD_REQUEST');
    // El detalle es la mejora que trae `conCredencial`: antes estas rutas
    // devolvían BAD_REQUEST pelado y el integrador no sabía qué campo falló.
    expect(respuesta.body.detalle).toBeTruthy();
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('resumen: sin certificado_base64 devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', certificado_password: 'yyy', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toBe('BAD_REQUEST');
    // El detalle es la mejora que trae `conCredencial`: antes estas rutas
    // devolvían BAD_REQUEST pelado y el integrador no sabía qué campo falló.
    expect(respuesta.body.detalle).toBeTruthy();
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('resumen: body inválido devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', periodo: 'no-es-un-periodo', operacion: 'VENTA' }
    );

    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('resumen: SesionNoIniciada del core se traduce a ERROR (no debería pasar en REST, pero no debe reventar)', async () => {
    (core.resumen as jest.Mock).mockRejectedValue(new Error('No hay sesión iniciada para el RUT 1. Llamá sii_iniciar_sesion primero.'));
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '1', certificado_base64: 'xxx', certificado_password: 'yyy', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta).toEqual({ status: 200, body: { ok: false, error: 'ERROR' } });
  });
  // Lo que cambió: estas rutas exigían certificado y ahora aceptan clave, igual
  // que las de BHE. Se verificó contra el portal que RCV se puede consultar con
  // clave tributaria, así que la exigencia era herencia del diseño y no del SII.
  it('resumen: acepta clave tributaria y llama al core', async () => {
    (core.resumen as jest.Mock).mockResolvedValue({ filas: [] });
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', clave: 'secreta', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta).toEqual({ status: 200, body: { ok: true, filas: [] } });
    expect(core.resumen).toHaveBeenCalled();
  });

  it('detalle: acepta clave tributaria y llama al core', async () => {
    (core.detalle as jest.Mock).mockResolvedValue({ documentos: [] });
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/detalle')!(
      { rut: '11.111.111-1', clave: 'secreta', periodo: '202607', operacion: 'COMPRA', tipo_doc: 33 }
    );

    expect(respuesta).toEqual({ status: 200, body: { ok: true, documentos: [] } });
  });

  // La regla de `conCredencial`: exactamente una de las dos. Mezclarlas es
  // ambiguo —no se sabe con cuál quiso autenticar— y adivinar sería peor que
  // rechazar, porque el caller creería que usó la que no se usó.
  it('resumen: clave junto con certificado se rechaza sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!({
      rut: '11.111.111-1', clave: 'secreta',
      certificado_base64: 'eHh4', certificado_password: 'yyy',
      periodo: '202607', operacion: 'VENTA',
    });

    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('resumen: sin ninguna credencial se rechaza sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });
});
