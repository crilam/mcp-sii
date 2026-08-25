import { registrarRutasRenta } from '../../../src/rest/rutas/renta';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/renta';

jest.mock('../../../src/core/renta');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasRenta(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasRenta', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 2 rutas bajo /v1/renta', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual(['POST /v1/renta/estado-declaracion', 'POST /v1/renta/f22']);
  });

  it('estado-declaracion: body válido llama al core', async () => {
    (core.estadoDeclaracion as jest.Mock).mockResolvedValue({ declaraciones: [] });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/renta/estado-declaracion')!({ rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', anio: 2026 });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, declaraciones: [] } });
  });

  it('f22: pasa folio opcional', async () => {
    (core.f22Completo as jest.Mock).mockResolvedValue({ lineas: [] });
    const rutas = armarRouter();
    await rutas.get('POST /v1/renta/f22')!({ rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', anio: 2026, folio: 5 });
    expect(core.f22Completo).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', 2026, 5);
  });
  // Estas rutas exigían certificado y ahora aceptan clave, igual que BHE.
  // Verificado contra el SII con clave real antes de relajar el schema.
  it('acepta clave tributaria y llama al core', async () => {
    (core.estadoDeclaracion as jest.Mock).mockResolvedValue({});
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/renta/estado-declaracion')!({ rut: '11.111.111-1', clave: 'secreta', anio: 2026 });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(core.estadoDeclaracion).toHaveBeenCalled();
  });

  // Exactamente una credencial: mezclarlas es ambiguo y adivinar sería peor que
  // rechazar, porque el caller creería que usó la que no se usó.
  it('rechaza clave junto con certificado sin llamar al core', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/renta/estado-declaracion')!({
      ...{ rut: '11.111.111-1', clave: 'secreta', anio: 2026 }, certificado_base64: 'eHh4', certificado_password: 'yyy',
    });

    expect(r.status).toBe(400);
    expect(core.estadoDeclaracion).not.toHaveBeenCalled();
  });

  it('rechaza un body sin ninguna credencial sin llamar al core', async () => {
    const rutas = armarRouter();
    const sinCred = { ...{ rut: '11.111.111-1', clave: 'secreta', anio: 2026 } } as Record<string, unknown>;
    delete sinCred.clave;

    const r = await rutas.get('POST /v1/renta/estado-declaracion')!(sinCred);

    expect(r.status).toBe(400);
    expect(core.estadoDeclaracion).not.toHaveBeenCalled();
  });
});
