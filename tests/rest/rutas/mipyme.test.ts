import { registrarRutasMipyme } from '../../../src/rest/rutas/mipyme';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/mipyme';

jest.mock('../../../src/core/mipyme');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasMipyme(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

const LINEA_MINIMA = { descripcion: 'Item', cantidad: 1, precio_unitario: 1000 };
const RECEPTOR_MINIMO = {
  receptor_rut: '33333333', receptor_dv: '1', receptor_razon_social: 'Test',
  receptor_giro: 'Giro', receptor_direccion: 'Calle 1', receptor_comuna: 'Santiago', receptor_ciudad: 'Santiago',
};

describe('registrarRutasMipyme', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 3 rutas bajo /v1/mipyme', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/mipyme/list-empresas', 'POST /v1/mipyme/list-dte-emitidos', 'POST /v1/mipyme/emitir-dte',
    ]);
  });

  it('list-empresas: body válido llama al core', async () => {
    (core.listEmpresas as jest.Mock).mockResolvedValue([]);
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/list-empresas')!({ rut: '11.111.111-1', clave: 'x' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, datos: [] } });
  });

  it('emitir-dte con confirmar=false (default) llama al core en modo previsualización', async () => {
    (core.emitirDte as jest.Mock).mockResolvedValue({ emitido: false, resumen: {} });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: 'x', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO,
    });
    expect(respuesta.status).toBe(200);
    expect(core.emitirDte).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', expect.any(Object), false);
  });

  it('emitir-dte con confirmar=true responde 400 CONFIRMAR_NO_SOPORTADO sin llamar al core', async () => {
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: 'x', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO, confirmar: true,
    });
    expect(respuesta).toEqual({ status: 400, body: { error: 'CONFIRMAR_NO_SOPORTADO' } });
    expect(core.emitirDte).not.toHaveBeenCalled();
  });
});
