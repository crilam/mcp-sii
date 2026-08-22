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

  it('registra las 4 rutas bajo /v1/bhe', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/bhe/resumen', 'POST /v1/bhe/list-emitidas',
      'POST /v1/bhe/list-recibidas', 'POST /v1/bhe/pdf',
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

  // El PDF viaja en base64 dentro del JSON: el contrato REST es todo {ok}, y
  // `ejecutar` spreadea el resultado, así que un Buffer devuelto crudo saldría
  // como {"0":37,"1":80,...}.
  it('pdf: devuelve el PDF en base64 con su tamaño, no el Buffer spreadeado', async () => {
    const contenido = Buffer.from('%PDF-1.3 boleta', 'latin1');
    (core.pdf as jest.Mock).mockResolvedValue(contenido);
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: '111111110000048F99ED',
    });

    expect(respuesta).toEqual({
      status: 200,
      body: {
        ok: true,
        codigo_barras: '111111110000048F99ED',
        content_type: 'application/pdf',
        nombre_archivo: 'bhe-111111110000048F99ED.pdf',
        tamano_bytes: contenido.length,
        pdf_base64: contenido.toString('base64'),
      },
    });
  });

  it('pdf: `recibida` es opcional y por defecto pide la emitida', async () => {
    (core.pdf as jest.Mock).mockResolvedValue(Buffer.from('x'));
    const rutas = armarRouter();

    await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: '111111110000048F99ED',
    });

    expect(core.pdf).toHaveBeenCalledWith(
      expect.anything(), '11.111.111-1', '111111110000048F99ED', false);
  });

  it('pdf: recibida:true llega al core', async () => {
    (core.pdf as jest.Mock).mockResolvedValue(Buffer.from('x'));
    const rutas = armarRouter();

    await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: '033333333034364C969E7', recibida: true,
    });

    expect(core.pdf).toHaveBeenCalledWith(
      expect.anything(), '11.111.111-1', '033333333034364C969E7', true);
  });

  // Sin `.trim()` en el schema, "   " pasaba la validación y moría adentro como
  // el ERROR genérico del contrato, en vez de un 400 que dice qué está mal.
  it('pdf: un codigo_barras en blanco devuelve 400, no ERROR', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: '   ',
    });

    expect(respuesta.status).toBe(400);
    expect(core.pdf).not.toHaveBeenCalled();
  });

  it('pdf: sin codigo_barras devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
    });

    expect(respuesta.status).toBe(400);
    expect(core.pdf).not.toHaveBeenCalled();
  });

  it('list-emitidas: pasa anio y mes al core', async () => {
    (core.listEmitidas as jest.Mock).mockResolvedValue([]);
    const rutas = armarRouter();
    await rutas.get('POST /v1/bhe/list-emitidas')!({ rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy', anio: 2026, mes: 7 });
    expect(core.listEmitidas).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', 2026, 7);
  });
});
