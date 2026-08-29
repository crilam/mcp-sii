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

  it('registra las 4 rutas bajo /v1/mipyme', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/mipyme/list-empresas', 'POST /v1/mipyme/list-dte-emitidos',
      'POST /v1/mipyme/list-dte-recibidos', 'POST /v1/mipyme/emitir-dte',
    ]);
  });

  it('list-empresas: body válido llama al core', async () => {
    (core.listEmpresas as jest.Mock).mockResolvedValue([]);
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/list-empresas')!({ rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, datos: [] } });
  });

  it('emitir-dte con confirmar=false (default) llama al core en modo previsualización', async () => {
    (core.emitirDte as jest.Mock).mockResolvedValue({ emitido: false, resumen: {} });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO,
    });
    expect(respuesta.status).toBe(200);
    expect(core.emitirDte).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', expect.any(Object), false);
  });

  it('emitir-dte con confirmar=true responde 400 CONFIRMAR_NO_SOPORTADO sin llamar al core', async () => {
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO, confirmar: true,
    });
    expect(respuesta).toEqual({ status: 400, body: { error: 'CONFIRMAR_NO_SOPORTADO' } });
    expect(core.emitirDte).not.toHaveBeenCalled();
  });
  // Las dos LECTURAS pasaron a aceptar clave tributaria (verificado contra el
  // portal: list-empresas devolvió las cinco empresas de la persona).
  it('list-empresas: acepta clave tributaria', async () => {
    (core.listEmpresas as jest.Mock).mockResolvedValue([{ rut: '1-9', nombre: 'X' }]);
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-empresas')!({ rut: '11.111.111-1', clave: 'secreta' });

    expect(r).toEqual({ status: 200, body: { ok: true, datos: [{ rut: '1-9', nombre: 'X' }] } });
  });

  it('list-dte-emitidos: acepta clave tributaria', async () => {
    (core.listDteEmitidos as jest.Mock).mockResolvedValue({ documentos: [] });
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-dte-emitidos')!({ rut: '11.111.111-1', clave: 'secreta' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('list-dte-recibidos: acepta clave tributaria', async () => {
    (core.listDteRecibidos as jest.Mock).mockResolvedValue({ documentos: [] });
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-dte-recibidos')!({
      rut: '11.111.111-1', clave: 'secreta',
    });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  // El filtro de contraparte del lado recibido es `emisor_rut`. Si la ruta
  // tomara `receptor_rut` por copiar la de emitidos, el filtro se perdería en
  // silencio y la respuesta traería TODO el historial.
  it('list-dte-recibidos: pasa emisor_rut al core como emisorRut', async () => {
    (core.listDteRecibidos as jest.Mock).mockResolvedValue({ documentos: [] });
    const rutas = armarRouter();

    await rutas.get('POST /v1/mipyme/list-dte-recibidos')!({
      rut: '11.111.111-1', clave: 'secreta', emisor_rut: '22222222-2', pagina: 2,
    });

    expect(core.listDteRecibidos).toHaveBeenCalledWith(
      expect.anything(), '11.111.111-1',
      expect.objectContaining({ emisorRut: '22222222-2', pagina: 2 }));
  });

  it('list-dte-recibidos: una página inválida es 400 y no llama al core', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/list-dte-recibidos')!({
      rut: '11.111.111-1', clave: 'secreta', pagina: 0,
    });

    expect(r.status).toBe(400);
    expect(core.listDteRecibidos).not.toHaveBeenCalled();
  });

  // La emisión NO cambió: firmar un DTE requiere el certificado de verdad, no
  // basta una sesión autenticada. Este test es el que impide que un futuro
  // "unifiquemos todo con conCredencial" habilite firmar con clave.
  it('emitir-dte: rechaza clave tributaria sin llamar al core', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: 'secreta', tipo_dte: 33,
      ...RECEPTOR_MINIMO, lineas: [LINEA_MINIMA],
    });

    expect(r.status).toBe(400);
    expect(core.emitirDte).not.toHaveBeenCalled();
  });

  // Y tampoco la mezcla. Sin el rechazo explícito de `clave`, este body pasaba
  // la validación, zod descartaba la clave en silencio y se FIRMABA con el
  // certificado: el caller creía haber usado una credencial y se usó la otra.
  it('emitir-dte: rechaza clave junto con certificado, sin firmar con el certificado', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: 'secreta',
      certificado_base64: 'eHh4', certificado_password: 'yyy',
      tipo_dte: 33, ...RECEPTOR_MINIMO, lineas: [LINEA_MINIMA],
    });

    expect(r.status).toBe(400);
    expect(core.emitirDte).not.toHaveBeenCalled();
  });
  // `null` no es `undefined`: con `z.undefined()` este body pasaba y se firmaba
  // con el certificado. Un consumidor que serializa sus campos vacíos como null
  // caía justo acá.
  it('emitir-dte: rechaza clave en null junto con certificado', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: null,
      certificado_base64: 'eHh4', certificado_password: 'yyy',
      tipo_dte: 33, ...RECEPTOR_MINIMO, lineas: [LINEA_MINIMA],
    });

    expect(r.status).toBe(400);
    expect(core.emitirDte).not.toHaveBeenCalled();
  });
});
