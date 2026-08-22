import { registrarRutasBhe } from '../../../src/rest/rutas/bhe';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/bhe';

jest.mock('../../../src/core/bhe');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasBhe(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasBhe', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 3 rutas bajo /v1/bhe', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/bhe/resumen', 'POST /v1/bhe/list-emitidas', 'POST /v1/bhe/list-recibidas',
    ]);
  });

  it('resumen: body válido llama al core y devuelve {ok:true, ...datos}', async () => {
    (core.resumen as jest.Mock).mockResolvedValue({ meses: [] });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({ rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', anio: 2026 });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, meses: [] } });
  });

  it('resumen: body inválido devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({ rut: '1', certificado_base64: 'xxx', certificado_password: 'yyy', anio: 1899 });
    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('list-emitidas: pasa anio y mes al core', async () => {
    (core.listEmitidas as jest.Mock).mockResolvedValue([]);
    const rutas = armarRouter();
    await rutas.get('POST /v1/bhe/list-emitidas')!({ rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', anio: 2026, mes: 7 });
    expect(core.listEmitidas).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', 2026, 7);
  });
});
