import { registrarRutasRcv } from '../../../src/rest/rutas/rcv';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/rcv';
import * as coreAsync from '../../../src/core/rcvAsync';

jest.mock('../../../src/core/rcv');
jest.mock('../../../src/core/rcvAsync');

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

  it('registra las 4 rutas bajo /v1/rcv', () => {
    const rutas = armarRouter();
    // Se comparan los CONJUNTOS y no el orden: el orden de inserción en el Map
    // no es contrato, así que fijarlo hace que agregar una ruta en medio rompa un
    // test que no protege nada real.
    expect(new Set(rutas.keys())).toEqual(new Set([
      'POST /v1/rcv/resumen',
      'POST /v1/rcv/empresas-autorizadas',
      'POST /v1/rcv/tipos-documento',
      'POST /v1/rcv/detalle',
      'POST /v1/rcv/async/solicitar',
      'POST /v1/rcv/async/estado',
      'POST /v1/rcv/async/detalle',
    ]));
  });

  describe('async (cierre R1)', () => {
    const cred = { rut: '11.111.111-1', clave: 'secreta', periodo: '202601', operacion: 'COMPRA', tipo_doc: 33 };

    it('solicitar: valida y pasa período/operación/tipo_doc al core', async () => {
      (coreAsync.solicitar as jest.Mock).mockResolvedValue({ solicitudId: 5, estado: 'CREADO' });
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/rcv/async/solicitar')!(cred);

      expect(r.body).toEqual({ ok: true, solicitudId: 5, estado: 'CREADO' });
      expect(coreAsync.solicitar).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', '202601', 'COMPRA', 33, undefined);
    });

    it('estado: un array se envuelve en datos', async () => {
      (coreAsync.estado as jest.Mock).mockResolvedValue([{ solicitudId: 5, estado: 'TERMINADO' }]);
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/rcv/async/estado')!(cred);

      expect(r.body).toEqual({ ok: true, datos: [{ solicitudId: 5, estado: 'TERMINADO' }] });
    });

    it('detalle: el objeto (columnas/filas) se spreadea', async () => {
      (coreAsync.detalle as jest.Mock).mockResolvedValue({ totalDocumentos: 2, columnas: ['Nro'], filas: [{ Nro: '1' }, { Nro: '2' }] });
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/rcv/async/detalle')!(cred);

      expect(r.body).toMatchObject({ ok: true, totalDocumentos: 2, columnas: ['Nro'] });
    });

    it('tipo_doc ausente es 400', async () => {
      const rutas = armarRouter();
      const r = await rutas.get('POST /v1/rcv/async/solicitar')!({ rut: '11.111.111-1', clave: 'x', periodo: '202601', operacion: 'COMPRA' });
      expect(r.status).toBe(400);
      expect(coreAsync.solicitar).not.toHaveBeenCalled();
    });
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
  // Las empresas autorizadas del RCV NO son las mismas que las de mipyme: éstas
  // son las que el RUT puede CONSULTAR en el registro, y las de mipyme las que
  // puede OPERAR en el portal de facturación. Confundirlas haría que un
  // consumidor ofrezca facturar por una empresa que sólo puede mirar.
  it('empresas-autorizadas: llama al core y envuelve la lista en datos', async () => {
    (core.empresasAutorizadas as jest.Mock).mockResolvedValue([
      { rut: '22222222-2', razonSocial: null, privilegios: null,
        fechaDesautorizacionUsuario: null, fechaDesautorizacionEmpresa: null },
    ]);
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/rcv/empresas-autorizadas')!(
      { rut: '11.111.111-1', clave: 'secreta' }
    );

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // Se envuelve en `datos` porque el core devuelve un array: es el contrato
    // general de `ejecutar`.
    expect(r.body.datos).toHaveLength(1);
  });

  it('empresas-autorizadas: sin credencial no llama al core', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/rcv/empresas-autorizadas')!({ rut: '11.111.111-1' });

    expect(r.status).toBe(400);
    expect(core.empresasAutorizadas).not.toHaveBeenCalled();
  });
  // El catálogo existe porque `detalle` exige un tipo de documento y no hay
  // "detalle del período entero": sin esto el consumidor adivina los códigos.
  it('tipos-documento: llama al core y envuelve el catálogo en datos', async () => {
    (core.tiposDocumento as jest.Mock).mockResolvedValue([
      { codigo: 33, nombre: 'Factura Electrónica', tipoIngreso: 'DET_ELE' },
    ]);
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/rcv/tipos-documento')!(
      { rut: '11.111.111-1', clave: 'secreta' }
    );

    expect(r.status).toBe(200);
    expect(r.body.datos).toHaveLength(1);
  });
  it('tipos-documento: sin credencial no llama al core', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/rcv/tipos-documento')!({ rut: '11.111.111-1' });

    expect(r.status).toBe(400);
    expect(core.tiposDocumento).not.toHaveBeenCalled();
  });
});
