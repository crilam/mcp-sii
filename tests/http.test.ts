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

// Arma la salida real de curl: los bytes del cuerpo, tal como llegan por el
// cable, seguidos de la marca y el Content-Type que agrega `-w`. Trabajar con
// Buffer y no con string es el punto: un test que parte de texto ya decodificado
// no puede, por construcción, detectar un error de decodificación.
function respuesta(cuerpo: Buffer | string, contentType: string): Buffer {
  const bytes = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'latin1');
  return Buffer.concat([
    bytes,
    Buffer.from(`\n__MCP_SII_CONTENT_TYPE__:${contentType}`, 'ascii'),
  ]);
}

beforeEach(() => jest.clearAllMocks());

// Regresión: contra el portal real, `sii_rcv_resumen` devolvía
// "Factura ElectrÃ³nica" porque el transporte fijaba latin1 para todo. El RCV
// responde UTF-8 y Renta F22 responde ISO-8859-1: hay que mirar el header.
describe('SiiHttpClient — decodificación por Content-Type', () => {
  // Los bytes de "Factura Electrónica" en cada encoding, escritos a mano para
  // que el test no dependa de cómo esté guardado este archivo fuente.
  const UTF8 = Buffer.from([
    ...Buffer.from('Factura Electr', 'ascii'), 0xc3, 0xb3,
    ...Buffer.from('nica', 'ascii'),
  ]);
  const LATIN1 = Buffer.from([
    ...Buffer.from('Factura Electr', 'ascii'), 0xf3,
    ...Buffer.from('nica', 'ascii'),
  ]);

  it('decodifica como UTF-8 cuando el header lo declara (RCV)', async () => {
    mockExec.mockReturnValue(
      respuesta(UTF8, 'application/json;charset=utf-8') as never
    );
    const { client } = makeClient();

    const texto = await client.get('https://www4.sii.cl/consdcvinternetui/x');

    expect(texto).toBe('Factura Electrónica');
  });

  it('decodifica como ISO-8859-1 cuando el header lo declara (Renta F22)', async () => {
    mockExec.mockReturnValue(
      respuesta(LATIN1, 'application/json;charset=ISO-8859-1') as never
    );
    const { client } = makeClient();

    const texto = await client.get('https://www4.sii.cl/consultaestadof22ui/x');

    expect(texto).toBe('Factura Electrónica');
  });

  // Los CGI legacy no siempre declaran charset y responden ISO-8859-1.
  it('usa ISO-8859-1 por defecto cuando no hay charset declarado', async () => {
    mockExec.mockReturnValue(respuesta(LATIN1, 'text/html') as never);
    const { client } = makeClient();

    const texto = await client.get('https://loa.sii.cl/cgi_IMT/X.cgi');

    expect(texto).toBe('Factura Electrónica');
  });

  // El header MIENTE: medido en vivo, Renta F22 declara `charset=ISO-8859-1`
  // y manda bytes UTF-8. Honrar la etiqueta devolvía "declaraciÃ³n". Por eso
  // se detecta UTF-8 por el contenido antes de creerle al header.
  it('detecta UTF-8 por contenido aunque el header declare ISO-8859-1 (F22)', async () => {
    mockExec.mockReturnValue(
      respuesta(UTF8, 'application/json;charset=ISO-8859-1') as never
    );
    const { client } = makeClient();

    const texto = await client.get('https://www4.sii.cl/consultaestadof22ui/x');

    expect(texto).toBe('Factura Electrónica');
    expect(texto).not.toContain('Ã');
  });

  // El riesgo del sniff es el inverso: confundir latin1 real con UTF-8. No
  // pasa porque UTF-8 es autovalidante — `0xF3` suelto no forma una secuencia
  // multibyte válida, así que la decodificación estricta lo rechaza.
  it('no confunde latin1 con UTF-8: 0xF3 suelto cae al charset declarado', async () => {
    mockExec.mockReturnValue(
      respuesta(Buffer.from([0xf3]), 'text/html;charset=ISO-8859-1') as never
    );
    const { client } = makeClient();

    expect(await client.get('https://loa.sii.cl/cgi_IMT/X.cgi')).toBe('ó');
  });

  it('no confunde latin1 con UTF-8 en un texto largo y realista', async () => {
    // "Declaración con observación: revisión de años anteriores. Ñuñoa."
    const frase = 'Declaraci\xf3n con observaci\xf3n: revisi\xf3n de a\xf1os anteriores. \xd1u\xf1oa.';
    const bytes = Buffer.from(frase, 'latin1');
    mockExec.mockReturnValue(
      respuesta(bytes, 'application/json;charset=ISO-8859-1') as never
    );
    const { client } = makeClient();

    const texto = await client.get('https://loa.sii.cl/cgi_IMT/X.cgi');

    expect(texto).toBe(
      'Declaración con observación: revisión de años anteriores. Ñuñoa.'
    );
  });

  // windows-1252 y latin1 sólo difieren en 0x80–0x9F: ahí windows-1252 tiene
  // imprimibles (€, comillas tipográficas, rayas) donde latin1 tiene controles
  // C1. Decodificar uno como el otro corrompe en silencio.
  it('decodifica windows-1252 con sus imprimibles de 0x80–0x9F', async () => {
    const bytes = Buffer.from([0x80, 0x93, 0xf3]); // € — ó
    mockExec.mockReturnValue(
      respuesta(bytes, 'text/html;charset=windows-1252') as never
    );
    const { client } = makeClient();

    expect(await client.get('https://www4.sii.cl/x')).toBe('€“ó');
  });

  // `TextDecoder` sigue la tabla WHATWG, donde el label `iso-8859-1` es alias
  // de windows-1252 — es lo que hace cualquier navegador contra el portal. Los
  // acentuados (0xC0–0xFF) son idénticos en ambas tablas, así que nada de lo
  // que ya funcionaba cambia; lo único que cambia es que 0x80–0x9F ahora dan el
  // imprimible en vez de un control C1 invisible.
  it('trata el label iso-8859-1 como lo hace el navegador (tabla WHATWG)', async () => {
    const bytes = Buffer.from([0x80, 0xf3]);
    mockExec.mockReturnValue(
      respuesta(bytes, 'application/json;charset=ISO-8859-1') as never
    );
    const { client } = makeClient();

    expect(await client.get('https://www4.sii.cl/x')).toBe('€ó');
  });

  // Un charset que no se reconoce no debe voltear la consulta: se cae al
  // default y se deja rastro en stderr.
  it('cae al default y avisa por stderr ante un charset desconocido', async () => {
    const aviso = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockExec.mockReturnValue(
      respuesta(LATIN1, 'application/json;charset=charset-inventado-9000') as never
    );
    const { client } = makeClient();

    const texto = await client.get('https://www4.sii.cl/x');

    expect(texto).toBe('Factura Electrónica');
    expect(aviso).toHaveBeenCalledWith(
      expect.stringContaining('charset-inventado-9000')
    );
    aviso.mockRestore();
  });

  it('no contamina el cuerpo con el Content-Type que agrega curl', async () => {
    mockExec.mockReturnValue(
      respuesta('{"a":1}', 'application/json;charset=utf-8') as never
    );
    const { client } = makeClient();

    const texto = await client.get('https://www4.sii.cl/x');

    expect(texto).toBe('{"a":1}');
    expect(texto).not.toContain('application/json');
  });
});

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

  // El charset varía por aplicación del portal, así que el transporte pide los
  // bytes crudos y decide después de leer el Content-Type.
  it('pide la salida de curl como bytes crudos', async () => {
    mockExec.mockReturnValue(respuesta('', 'text/html') as never);
    const { client } = makeClient();

    await client.get('https://loa.sii.cl/cgi_IMT/X.cgi');

    const opts = mockExec.mock.calls[0][2] as { encoding?: string };
    expect(opts.encoding).toBe('buffer');
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
    // `--data-binary` en vez de `-d`: el cuerpo ya viene percent-encodeado y no
    // debe ser reinterpretado. El Content-Type va explícito porque el POST de
    // emisión del portal mipyme lo exige.
    expect(args).toContain('--data-binary');
    expect(args).toContain('Content-Type: application/x-www-form-urlencoded');
    expect(args.some(arg => arg.includes('rut_arrastre=11111111'))).toBe(true);
    expect(args.some(arg => arg.includes('cbmesinformemensual=03'))).toBe(true);
  });

  it('codifica en ISO-8859-1 cuando se lo piden, no en UTF-8', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    await client.postForm(
      'https://www1.sii.cl/cgi-bin/Portal001/mipeDisplayPreView.cgi',
      { EFXP_RZN_SOC: 'ASESORÍAS SPA' },
      { charset: 'latin1' }
    );

    // La `Í` es 0xCD en latin1 y 0xC3 0x8D en UTF-8. El CGI lee latin1: con el
    // encoding por defecto emitiría el DTE con la razón social del emisor
    // corrupta, y eso no lo avisa ningún error.
    const args = mockExec.mock.calls[0][1] as string[];
    expect(args.some(arg => arg.includes('ASESOR%CDAS%20SPA') || arg.includes('ASESOR%CDAS+SPA'))).toBe(true);
    expect(args.some(arg => arg.includes('%C3%8D'))).toBe(false);
  });

  it('falla ante un carácter que no existe en latin1, en vez de corromperlo en silencio', async () => {
    // Buffer.from(x, 'latin1') trunca al byte bajo: un carácter fuera de latin1
    // (€, un emoji) saldría convertido en otro byte, sin error, y emitiría un
    // documento tributario con el dato equivocado. Estos valores vienen de
    // parámetros de la tool, así que el borde es alcanzable. Mejor un error
    // claro que un DTE corrupto.
    const { client } = makeClient();

    await expect(
      client.postForm(
        'https://www1.sii.cl/cgi-bin/Portal001/mipeDisplayPreView.cgi',
        { EFXP_RZN_SOC: 'CAFÉ €URO' },
        { charset: 'latin1' }
      )
    ).rejects.toThrow(/latin1|ISO-8859-1/i);
  });

  it('escapa los valores con caracteres especiales', async () => {
    mockExec.mockReturnValue('<html>ok</html>' as never);
    const { client } = makeClient();

    await client.postForm('https://loa.sii.cl/cgi_IMT/Y.cgi', { glosa: 'a b&c' });

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args.some(arg => arg.includes('glosa=a%20b%26c'))).toBe(true);
  });
});

// El PDF de una boleta de honorarios no es texto: pasarlo por TextDecoder
// reemplaza cada byte que no forma una secuencia válida por U+FFFD, y el daño
// es irreversible y silencioso (el resultado sigue siendo un string).
describe('SiiHttpClient.getBinario', () => {
  // La cabecera real de un PDF: arranca con %PDF y sigue con bytes altos que no
  // son UTF-8 válido, así que un round-trip por string los perdería.
  const PDF = Buffer.from([
    ...Buffer.from('%PDF-1.3\n', 'ascii'), 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
  ]);

  it('devuelve los bytes crudos y el Content-Type, sin decodificar', async () => {
    mockExec.mockReturnValue(respuesta(PDF, 'application/pdf') as never);
    const { client } = makeClient();

    const r = await client.getBinario('https://loa.sii.cl/cgi_IMT/TMBCOT_ConsultaBoletaPdf.cgi');

    expect(r.contentType).toBe('application/pdf');
    expect(r.contenido.equals(PDF)).toBe(true);
  });

  it('percent-encodea los parámetros en el query string', async () => {
    mockExec.mockReturnValue(respuesta(PDF, 'application/pdf') as never);
    const { client } = makeClient();

    await client.getBinario('https://loa.sii.cl/cgi_IMT/TMBCOT_ConsultaBoletaPdf.cgi',
      { txt_codigobarras: 'ABC123', origen: 'PROPIOS' });

    const args = mockExec.mock.calls[0][1] as string[];
    expect(args.some(a => a.includes('txt_codigobarras=ABC123&origen=PROPIOS'))).toBe(true);
  });

  // Sin maxBuffer explícito, execFileSync corta en 1 MiB y lanza ENOBUFS. El
  // PDF de una boleta es el primer payload que puede pasar ese límite.
  it('declara un maxBuffer mayor al default de 1 MiB de Node', async () => {
    mockExec.mockReturnValue(respuesta(PDF, 'application/pdf') as never);
    const { client } = makeClient();

    await client.getBinario('https://loa.sii.cl/cgi_IMT/TMBCOT_ConsultaBoletaPdf.cgi');

    const opciones = mockExec.mock.calls[0][2] as { maxBuffer?: number };
    expect(opciones.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  // `get`/`postForm` y `getBinario` comparten `curlCrudo`, así que el límite
  // vale para los dos caminos. Cubrir el de texto es barato y deja claro que no
  // es una propiedad exclusiva del binario.
  it('el camino de texto hereda el mismo maxBuffer', async () => {
    mockExec.mockReturnValue(respuesta('<html>ok</html>', 'text/html') as never);
    const { client } = makeClient();

    await client.get('https://loa.sii.cl/cgi_IMT/TMBCOC_InformeAnualBhe.cgi');

    const opciones = mockExec.mock.calls[0][2] as { maxBuffer?: number };
    expect(opciones.maxBuffer).toBeGreaterThan(1024 * 1024);
  });

  // Cuando el CGI responde el HTML del login, quien llama necesita ver ese
  // Content-Type para distinguirlo de un PDF: el status es 200 en ambos casos.
  it('reporta el Content-Type de una respuesta que no es PDF', async () => {
    mockExec.mockReturnValue(
      respuesta('<html><title>Autenticación</title></html>', 'text/html; charset=iso-8859-1') as never
    );
    const { client } = makeClient();

    const r = await client.getBinario('https://loa.sii.cl/cgi_IMT/TMBCOT_ConsultaBoletaPdf.cgi');

    expect(r.contentType).toBe('text/html; charset=iso-8859-1');
  });
});
