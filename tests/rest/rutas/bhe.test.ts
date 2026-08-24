import { registrarRutasBhe } from '../../../src/rest/rutas/bhe';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/bhe';
import { LimitacionConocida, RecursoNoEncontrado } from '../../../src/erroresConsulta';

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

  // Sin un código propio, un identificador equivocado (permanente) y una caída
  // del portal (transitoria) devolvían los mismos bytes, y el tenant reintentaba
  // en loop lo que no iba a funcionar nunca.
  it('pdf: una boleta inexistente devuelve NO_ENCONTRADO, no ERROR', async () => {
    (core.pdf as jest.Mock).mockRejectedValue(
      new RecursoNoEncontrado('el SII informa que no existe una boleta')
    );
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: '99999999999999999999',
    });

    // Con `detalle`: el mensaje distingue "código inexistente" de "pediste una
    // recibida como emitida", que el SII responde igual y el tenant sí puede
    // accionar.
    expect(respuesta).toEqual({
      status: 200,
      body: {
        ok: false,
        error: 'NO_ENCONTRADO',
        detalle: 'el SII informa que no existe una boleta',
      },
    });
  });

  // El listado deja codigoBarras en '' cuando el SII no lo informa; si el tenant
  // reenvía eso, tiene que ser un 400 y no gastar una consulta al SII.
  it('pdf: un codigo_barras vacío devuelve 400', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: '',
    });

    expect(respuesta.status).toBe(400);
    expect(core.pdf).not.toHaveBeenCalled();
  });

  // ERROR significa "reintentá". Un limite conocido —un mes de recibidas con mas
  // de 100 boletas, un descuadre de conteo, un cambio de formato del CGI— es
  // permanente: con ERROR el tenant reintentaria en loop un mes que nunca va a
  // funcionar.
  it('un limite conocido devuelve LIMITE_CONOCIDO con detalle, no ERROR', async () => {
    (core.listRecibidas as jest.Mock).mockRejectedValue(
      new LimitacionConocida('El SII informa 150 boletas recibidas y entrega 100 por pagina')
    );
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/list-recibidas')!({
      rut: '11.111.111-1', clave: 'secreta', anio: 2026, mes: 7,
    });

    expect(respuesta).toEqual({
      status: 200,
      body: {
        ok: false,
        error: 'LIMITE_CONOCIDO',
        detalle: 'El SII informa 150 boletas recibidas y entrega 100 por pagina',
      },
    });
  });

  // `resumen` es la ruta que estrena el throw nuevo del informe anual, asi que
  // se cubre por separado de `list-recibidas`.
  it('resumen: un limite conocido tambien sale como LIMITE_CONOCIDO', async () => {
    (core.resumen as jest.Mock).mockRejectedValue(
      new LimitacionConocida('El informe anual trae datos para el mes 3 pero ningun folio')
    );
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({
      rut: '11.111.111-1', clave: 'secreta', anio: 2026,
    });

    expect((respuesta.body as { error: string }).error).toBe('LIMITE_CONOCIDO');
    expect((respuesta.body as { detalle?: string }).detalle).toMatch(/mes 3/);
  });

  // RecursoNoEncontrado extiende LimitacionConocida, asi que el orden de los
  // `instanceof` decide: el caso mas especifico tiene que ganar.
  it('una boleta inexistente sigue siendo NO_ENCONTRADO, no LIMITE_CONOCIDO', async () => {
    (core.pdf as jest.Mock).mockRejectedValue(new RecursoNoEncontrado('no existe'));
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', clave: 'secreta', codigo_barras: 'ABC123',
    });

    expect((respuesta.body as { error: string }).error).toBe('NO_ENCONTRADO');
  });

  it('pdf: un fallo transitorio sigue siendo ERROR', async () => {
    (core.pdf as jest.Mock).mockRejectedValue(new Error('el portal respondió algo inesperado'));
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: '111111110000048F99ED',
    });

    expect(respuesta).toEqual({ status: 200, body: { ok: false, error: 'ERROR' } });
  });

  it('pdf: un codigo_barras absurdamente largo devuelve 400', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: 'A'.repeat(5_000),
    });

    expect(respuesta.status).toBe(400);
    expect(core.pdf).not.toHaveBeenCalled();
  });

  // `base64` sin `-w0` (el default en BSD y GNU) corta la salida en lineas, asi
  // que un .pfx codificado con el comando de siempre trae saltos: rechazarlo
  // seria rechazar un certificado que funciona por el formato del volcado.
  it('acepta un certificado en base64 con saltos de linea', async () => {
    (core.resumen as jest.Mock).mockResolvedValue({ meses: [] });
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({
      rut: '11.111.111-1',
      certificado_base64: 'TUlJS\nlRnZ0lC\nQWdJQ0FR\n',
      certificado_password: 'yyy',
      anio: 2026,
    });

    expect(respuesta).toEqual({ status: 200, body: { ok: true, meses: [] } });
  });

  // La clave tributaria ahora alcanza: estas consultas van por HTTP con el
  // cookie jar, y el login por clave lo produce igual que el certificado.
  it('acepta clave tributaria en vez de certificado', async () => {
    (core.resumen as jest.Mock).mockResolvedValue({ meses: [] });
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({
      rut: '11.111.111-1', clave: 'secreta', anio: 2026,
    });

    expect(respuesta).toEqual({ status: 200, body: { ok: true, meses: [] } });
  });

  // Mandar las dos es un error del llamador, no algo a resolver con una
  // prioridad implicita: con `certPath ? cert : clave` en env.ts era imposible
  // saber con que se habia autenticado una consulta.
  it('rechaza mandar clave y certificado a la vez', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({
      rut: '11.111.111-1', clave: 'secreta',
      certificado_base64: 'xxx', certificado_password: 'yyy', anio: 2026,
    });

    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });

  // El mensaje del schema estaba escrito con cuidado y se descartaba: el
  // llamador recibia un BAD_REQUEST pelado y tenia que adivinar cual de los
  // campos era el problema.
  it('el 400 dice QUE estuvo mal, no solo BAD_REQUEST', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', clave: 'secreta', codigo_barras: 'no-alfanumerico!',
    });

    expect(respuesta.status).toBe(400);
    expect((respuesta.body as { error: string }).error).toBe('BAD_REQUEST');
    expect((respuesta.body as { detalle?: string }).detalle).toMatch(/codigo_barras/);
  });

  it('rechaza no mandar ninguna credencial', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({
      rut: '11.111.111-1', anio: 2026,
    });

    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });

  // El `nombre_archivo` que devuelve la ruta suele terminar como nombre de
  // archivo real en el consumidor: un separador acá es path traversal allá.
  it('pdf: rechaza un codigo_barras con separadores de ruta', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/bhe/pdf')!({
      rut: '11.111.111-1', certificado_base64: 'xxx', certificado_password: 'yyy',
      codigo_barras: '../../../tmp/x',
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
