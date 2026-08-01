import { execFileSync } from 'child_process';
import { SiiHttpClient } from '../src/http';
import { SessionManager } from '../src/session';

jest.mock('child_process');
jest.mock('../src/session');

const mockExec = execFileSync as jest.MockedFunction<typeof execFileSync>;
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

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args).toContain('-b');
    expect(args).toContain('/tmp/sii_cookies.txt');
  });

  it('agrega los parámetros al query string', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    await client.get('https://loa.sii.cl/cgi_IMT/X.cgi', { anio: '2025', dv: '4' });

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args.some(arg => arg.includes('anio=2025'))).toBe(true);
    expect(args.some(arg => arg.includes('dv=4'))).toBe(true);
  });

  // El SII responde ISO-8859-1 incluso en JSON. Leer como UTF-8 corrompe
  // cualquier texto con tilde, y el daño aparece lejos de la causa.
  it('decodifica la respuesta como ISO-8859-1', async () => {
    mockExec.mockReturnValue('' as never);
    const { client } = makeClient();

    await client.get('https://loa.sii.cl/cgi_IMT/X.cgi');

    const opts = mockExec.mock.calls[0][2] as { encoding?: string };
    expect(opts.encoding).toBe('latin1');
  });

  // execFileSync con arreglo de argumentos previene inyección de shell.
  // URLs con metacaracteres de shell deben ser literales y no alterar el comando.
  it('previene inyección de shell en la URL', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    // Intentamos inyectar metacaracteres de shell en la URL
    const maliciousUrl = 'https://loa.sii.cl/X.cgi"; echo "hacked';
    await client.get(maliciousUrl);

    const args = mockExec.mock.calls[0][1] as string[];
    // La URL completa (incluyendo los metacaracteres) debe estar en los argumentos,
    // sin ser interpretada como comando. Verificamos que el último argumento
    // sea la URL literal.
    expect(args[args.length - 1]).toBe(maliciousUrl);
  });

  // Más patrones de inyección de shell que deben ser seguros
  it('URL con backtick, $() y punto y coma son literales', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    const maliciousUrl = 'https://loa.sii.cl/X.cgi`whoami`$(cat /etc/passwd);';
    await client.get(maliciousUrl);

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe(maliciousUrl);
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

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args).toContain('-d');
    expect(args.some(arg => arg.includes('rut_arrastre=11111111'))).toBe(true);
    expect(args.some(arg => arg.includes('cbmesinformemensual=03'))).toBe(true);
  });

  it('escapa los valores con caracteres especiales', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    await client.postForm('https://loa.sii.cl/cgi_IMT/Y.cgi', { glosa: 'a b&c' });

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args.some(arg => arg.includes('glosa=a%20b%26c'))).toBe(true);
  });
});
