import { execSync } from 'child_process';
import { SiiHttpClient } from '../src/http';
import { SessionManager } from '../src/session';

jest.mock('child_process');
jest.mock('../src/session');

const mockExec = execSync as jest.MockedFunction<typeof execSync>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function makeClient() {
  const session = new MockSession({} as any, {} as any);
  (session.rutaCookieJar as jest.Mock).mockResolvedValue('/tmp/sii_cookies.txt');
  return { session, client: new SiiHttpClient(session) };
}

beforeEach(() => jest.clearAllMocks());

describe('SiiHttpClient.get', () => {
  it('manda las cookies de la sesión compartida', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    await client.get('https://loa.sii.cl/cgi_IMT/X.cgi');

    const cmd = String(mockExec.mock.calls[0][0]);
    expect(cmd).toContain('-b "/tmp/sii_cookies.txt"');
  });

  it('agrega los parámetros al query string', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    await client.get('https://loa.sii.cl/cgi_IMT/X.cgi', { anio: '2025', dv: '4' });

    const cmd = String(mockExec.mock.calls[0][0]);
    expect(cmd).toContain('anio=2025');
    expect(cmd).toContain('dv=4');
  });

  // El SII responde ISO-8859-1 incluso en JSON. Leer como UTF-8 corrompe
  // cualquier texto con tilde, y el daño aparece lejos de la causa.
  it('decodifica la respuesta como ISO-8859-1', async () => {
    mockExec.mockReturnValue('' as never);
    const { client } = makeClient();

    await client.get('https://loa.sii.cl/cgi_IMT/X.cgi');

    const opts = mockExec.mock.calls[0][1] as { encoding?: string };
    expect(opts.encoding).toBe('latin1');
  });
});

describe('SiiHttpClient.postForm', () => {
  it('manda los campos como application/x-www-form-urlencoded', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    await client.postForm('https://loa.sii.cl/cgi_IMT/Y.cgi', {
      rut_arrastre: '11111111',
      cbmesinformemensual: '03',
    });

    const cmd = String(mockExec.mock.calls[0][0]);
    expect(cmd).toContain('-d "rut_arrastre=11111111&cbmesinformemensual=03"');
  });

  it('escapa los valores con caracteres especiales', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    await client.postForm('https://loa.sii.cl/cgi_IMT/Y.cgi', { glosa: 'a b&c' });

    const cmd = String(mockExec.mock.calls[0][0]);
    expect(cmd).toContain('glosa=a%20b%26c');
  });
});
