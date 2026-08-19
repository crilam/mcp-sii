import { registrarRutasDte } from '../../../src/rest/rutas/dte';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/dte';

jest.mock('../../../src/core/dte');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasDte(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasDte', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 4 rutas bajo /v1/dte', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/dte/list-documentos-emitidos',
      'POST /v1/dte/list-documentos-recibidos',
      'POST /v1/dte/get-documento-emitido',
      'POST /v1/dte/get-documento-recibido',
    ]);
  });

  it('list-documentos-emitidos: body válido llama a core.listar con EMITIDOS', async () => {
    (core.listar as jest.Mock).mockResolvedValue({ filas: [] });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/dte/list-documentos-emitidos')!({
      rut: '11.111.111-1', clave: 'x', periodo: '202607',
    });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, filas: [] } });
    expect(core.listar).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', '202607', 'EMITIDOS', expect.any(Object));
  });

  it('get-documento-recibido: body válido llama a core.getDocumento con RECIBIDOS', async () => {
    (core.getDocumento as jest.Mock).mockResolvedValue({ encontrado: false });
    const rutas = armarRouter();
    await rutas.get('POST /v1/dte/get-documento-recibido')!({
      rut: '11.111.111-1', clave: 'x', periodo: '202607', tipo_doc: 33, folio: 100,
    });
    expect(core.getDocumento).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', '202607', 'RECIBIDOS', 33, 100, undefined);
  });

  it('body inválido (falta periodo) devuelve 400', async () => {
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/dte/list-documentos-emitidos')!({ rut: '1', clave: 'x' });
    expect(respuesta.status).toBe(400);
  });
});
