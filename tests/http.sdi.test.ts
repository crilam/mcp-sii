import { execFileSync } from 'child_process';
import { SiiHttpClient } from '../src/http';
import { SessionManager } from '../src/session';
import { LimiteDeConsultasSii } from '../src/erroresConsulta';

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

// El SII corta por volumen devolviendo una PÁGINA HTML, no un status 429, así
// que sin mirar el cuerpo es indistinguible de "la sesión expiró". Y las dos
// cosas piden lo contrario: una que esperes, la otra que reintentes ya.
describe('SiiHttpClient.postSdi ante el corte por volumen del SII', () => {
  it('distingue el error 429 del SII de una sesión expirada', async () => {
    const { client } = makeClient();
    mockExec.mockReturnValue(
      '<html><body><div>Error 429: Se ha superado el límite de consultas</div></body></html>' as never
    );

    await expect(client.postSdi(BASE, NAMESPACE, 'getResumen', {}))
      .rejects.toThrow(LimiteDeConsultasSii);
  });

  it('reconoce también la variante sin el número, por si cambia el copy', async () => {
    const { client } = makeClient();
    mockExec.mockReturnValue(
      '<html><body>Se ha superado el limite permitido</body></html>' as never
    );

    await expect(client.postSdi(BASE, NAMESPACE, 'getResumen', {}))
      .rejects.toThrow(LimiteDeConsultasSii);
  });

  // El HTML del login NO es un corte por volumen: ahí sí corresponde el error
  // genérico, porque reintentar (reautenticando) es lo que arregla el caso.
  it('el HTML del login sigue siendo el error genérico', async () => {
    const { client } = makeClient();
    mockExec.mockReturnValue(
      '<html><body><form action="CAutInicio.cgi">Ingrese su clave</form></body></html>' as never
    );

    const fallo = client.postSdi(BASE, NAMESPACE, 'getResumen', {});
    await expect(fallo).rejects.toThrow(/no devolvió JSON/);
    await expect(fallo).rejects.not.toThrow(LimiteDeConsultasSii);
  });
});

// El corte es por PORTAL, no por vía: si afecta a las consultas SDI, afecta
// también a las páginas HTML del mismo portal. Antes la detección vivía sólo en
// `postSdi`, así que los scrapers que leen HTML —BHE, bienes raíces, mipyme—
// veían el corte como un error genérico y lo reintentaban.
describe('SiiHttpClient.get ante el corte por volumen', () => {
  it('detecta el 429 del SII también en una consulta de HTML', async () => {
    const { client } = makeClient();
    mockExec.mockReturnValue(
      '<html><body><div>Error 429: Se ha superado el límite de consultas</div></body></html>' as never
    );

    await expect(client.get('https://loa.sii.cl/cgi_IMT/algo.cgi', {}))
      .rejects.toThrow(LimiteDeConsultasSii);
  });

  // Un HTML normal no puede confundirse con el corte, o cada consulta buena
  // fallaría.
  it('un HTML normal pasa sin problema', async () => {
    const { client } = makeClient();
    mockExec.mockReturnValue('<html><body>informe con datos</body></html>' as never);

    await expect(client.get('https://loa.sii.cl/cgi_IMT/algo.cgi', {}))
      .resolves.toContain('informe con datos');
  });
});
