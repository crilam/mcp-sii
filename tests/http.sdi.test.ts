import { execFileSync } from 'child_process';
import { SiiHttpClient } from '../src/http';
import { SessionManager } from '../src/session';

jest.mock('child_process');
jest.mock('../src/session');

const mockExec = execFileSync as jest.MockedFunction<typeof execFileSync>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

const NAMESPACE = 'cl.sii.sdi.lob.renta.consultaestadof22.data.api.interfaces.FacadeService';
const BASE = 'https://www4.sii.cl/consultaestadof22ui/services/data/facadeService';

function makeClient(token = 'TOKEN-DE-PRUEBA') {
  const session = new MockSession({} as any, {} as any);
  (session.rutaCookieJar as jest.Mock).mockResolvedValue('/tmp/sii_cookies.txt');
  (session.conversationId as jest.Mock).mockReturnValue(token);
  return { session, client: new SiiHttpClient(session) };
}

// El cuerpo va en el argumento siguiente a --data-binary.
function cuerpoEnviado(): any {
  const args = mockExec.mock.calls[0][1] as string[];
  const i = args.indexOf('--data-binary');
  return JSON.parse(args[i + 1]);
}

beforeEach(() => jest.clearAllMocks());

describe('SiiHttpClient.postSdi', () => {
  it('arma el namespace como <interfaz>/<metodo>', async () => {
    mockExec.mockReturnValue('{"data":{}}' as never);
    const { client } = makeClient();

    await client.postSdi(BASE, NAMESPACE, 'buscaDeclVgte', { rut: '11111111' });

    expect(cuerpoEnviado().metaData.namespace).toBe(`${NAMESPACE}/buscaDeclVgte`);
  });

  // El conversationId es el valor de la cookie TOKEN, y quien la conoce es
  // SessionManager: el transporte no puede leer el cookie jar por su cuenta.
  it('usa la cookie TOKEN de la sesión como conversationId', async () => {
    mockExec.mockReturnValue('{"data":{}}' as never);
    const { client, session } = makeClient('abc123');

    await client.postSdi(BASE, NAMESPACE, 'buscaDeclVgte', {});

    expect(session.conversationId).toHaveBeenCalled();
    expect(cuerpoEnviado().metaData.conversationId).toBe('abc123');
  });

  // Los parámetros del método van anidados dentro de `data`, no en la raíz.
  // En la raíz, el SII responde "Acceso no autorizado!".
  it('anida los parámetros del método dentro de data', async () => {
    mockExec.mockReturnValue('{"data":{}}' as never);
    const { client } = makeClient();

    await client.postSdi(BASE, NAMESPACE, 'f22Completo', {
      rut: '11111111', dv: '1', folio: '900000001', periodo: '2025',
    });

    const cuerpo = cuerpoEnviado();
    expect(cuerpo.data).toEqual({
      rut: '11111111', dv: '1', folio: '900000001', periodo: '2025',
    });
    expect(cuerpo.rut).toBeUndefined();
  });

  it('manda page en null', async () => {
    mockExec.mockReturnValue('{"data":{}}' as never);
    const { client } = makeClient();

    await client.postSdi(BASE, NAMESPACE, 'buscaDeclVgte', {});

    expect(cuerpoEnviado().metaData.page).toBeNull();
  });

  it('da un transactionId distinto a cada petición', async () => {
    mockExec.mockReturnValue('{"data":{}}' as never);
    const { client } = makeClient();

    await client.postSdi(BASE, NAMESPACE, 'buscaDeclVgte', {});
    await client.postSdi(BASE, NAMESPACE, 'buscaDeclVgte', {});

    const ids = mockExec.mock.calls.map(c => {
      const args = c[1] as string[];
      return JSON.parse(args[args.indexOf('--data-binary') + 1]).metaData.transactionId;
    });
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('postea al método sobre la URL base y declara JSON', async () => {
    mockExec.mockReturnValue('{"data":{}}' as never);
    const { client } = makeClient();

    await client.postSdi(`${BASE}/`, NAMESPACE, 'buscaDeclVgte', {});

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe(`${BASE}/buscaDeclVgte`);
    expect(args).toContain('Content-Type: application/json');
  });

  it('manda las cookies de la sesión compartida', async () => {
    mockExec.mockReturnValue('{"data":{}}' as never);
    const { client } = makeClient();

    await client.postSdi(BASE, NAMESPACE, 'buscaDeclVgte', {});

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args).toContain('-b');
    expect(args).toContain('/tmp/sii_cookies.txt');
  });

  it('devuelve el JSON parseado', async () => {
    mockExec.mockReturnValue('{"data":{"decls":[]},"respCod":0}' as never);
    const { client } = makeClient();

    const resp = await client.postSdi(BASE, NAMESPACE, 'buscaDeclVgte', {});

    expect(resp).toEqual({ data: { decls: [] }, respCod: 0 });
  });

  // Una respuesta HTML (login caído, error del portal) no puede llegar como
  // objeto roto al parser: el fallo aparecería lejísimos de la causa.
  it('falla con un mensaje claro si la respuesta no es JSON', async () => {
    mockExec.mockReturnValue('<html>sesión expirada</html>' as never);
    const { client } = makeClient();

    await expect(client.postSdi(BASE, NAMESPACE, 'buscaDeclVgte', {}))
      .rejects.toThrow(/no devolvió JSON/);
  });
});
