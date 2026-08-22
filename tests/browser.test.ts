import { execFileSync } from 'child_process';
import { Browser, ErrorDeBrowser } from '../src/browser';
import * as util from 'util';

jest.mock('child_process', () => ({ execFileSync: jest.fn(), execSync: jest.fn() }));
const mockExec = execFileSync as jest.MockedFunction<typeof execFileSync>;

describe('Browser', () => {
  let browser: Browser;

  beforeEach(() => {
    browser = new Browser();
    mockExec.mockReset();
  });

  it('open navega a la URL indicada', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.open('https://example.com');
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser',
      ['open', 'https://example.com'],
      expect.any(Object)
    );
  });

  it('snapshot retorna el texto del arbol de accesibilidad', () => {
    const tree = '[button @e1 "Ingresar"]';
    mockExec.mockReturnValue(Buffer.from(tree));
    expect(browser.snapshot()).toBe(tree);
    expect(mockExec).toHaveBeenCalledWith('agent-browser', ['snapshot'], expect.any(Object));
  });

  it('click ejecuta click sobre el ref', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.click('@e1');
    expect(mockExec).toHaveBeenCalledWith('agent-browser', ['click', '@e1'], expect.any(Object));
  });

  it('fill limpia y rellena el campo', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.fill('@e2', 'texto de prueba');
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser',
      ['fill', '@e2', 'texto de prueba'],
      expect.any(Object)
    );
  });

  it('getText retorna el texto del elemento', () => {
    mockExec.mockReturnValue(Buffer.from('Texto del elemento'));
    expect(browser.getText('@e3')).toBe('Texto del elemento');
    expect(mockExec).toHaveBeenCalledWith('agent-browser', ['get', 'text', '@e3'], expect.any(Object));
  });

  // Comando dedicado, no eval('document.location.href'): confirmado en prod
  // que evaluar JS justo después de una navegación puede pegarle a un
  // contexto de ejecución destruido y devolver un error en vez de la URL.
  it('getUrl usa el comando dedicado del CLI', () => {
    mockExec.mockReturnValue(Buffer.from('https://mipyme.sii.cl/'));
    expect(browser.getUrl()).toBe('https://mipyme.sii.cl/');
    expect(mockExec).toHaveBeenCalledWith('agent-browser', ['get', 'url'], expect.any(Object));
  });

  it('select elige una opcion del dropdown', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.select('@e4', '11111111');
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser',
      ['select', '@e4', '11111111'],
      expect.any(Object)
    );
  });

  it('close cierra el browser', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.close();
    expect(mockExec).toHaveBeenCalledWith('agent-browser', ['close'], expect.any(Object));
  });

  it('con sessionId, antepone --session a cada comando', () => {
    const browser2 = new Browser('11111111-1');
    mockExec.mockReturnValue(Buffer.from(''));
    browser2.open('https://example.com');
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser',
      ['--session', '11111111-1', 'open', 'https://example.com'],
      expect.any(Object)
    );
  });

  it('sin sessionId, no antepone --session (comportamiento actual intacto)', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.snapshot();
    expect(mockExec).toHaveBeenCalledWith('agent-browser', ['snapshot'], expect.any(Object));
  });

  // Bug real en prod: una clave tributaria con comillas/`$`/backtick/`\` rompía
  // el comando ("Unterminated quoted string") cuando `run()` armaba un string
  // de shell por interpolación — o peor, podía inyectar comandos arbitrarios,
  // ya que la clave llega del body de /v1/sesion/validar-clave (tenant
  // externo). Con execFileSync + argv array, el texto viaja como UN argumento
  // sin pasar por ningún shell: estos caracteres no tienen significado especial.
  it('fill con caracteres especiales de shell no rompe el comando ni inyecta nada', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    const claveMaliciosa = `o'brien"$(rm -rf /)\`whoami\`\\ con espacios`;
    browser.fill('@e2', claveMaliciosa);
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser',
      ['fill', '@e2', claveMaliciosa],
      expect.any(Object)
    );
  });

  // Verificado a mano contra el binario real: `agent-browser fill @e3 "--session"`
  // NO reinterpreta el valor como flag — resuelve <selector>/<text> por
  // posición para un subcomando de aridad fija, no escaneando tokens con
  // guión entre los argumentos. Se documenta acá para que quede como
  // regresión: si `run()` alguna vez cambia a pasar los argumentos por otro
  // medio (por ejemplo, uniéndolos de nuevo en un string), este test lo
  // detecta.
  it('un valor que empieza con guión (aunque parezca un flag) viaja como argumento posicional, no como flag', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.fill('@e2', '--session');
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser',
      ['fill', '@e2', '--session'],
      expect.any(Object)
    );
  });

  it('eval ya no necesita escapar comillas manualmente (van como argumento propio)', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.eval('document.title === "algo"');
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser',
      ['eval', 'document.title === "algo"'],
      expect.any(Object)
    );
  });

  // Fuga real verificada: el `message` de execFileSync arranca con
  // "Command failed: " + el comando COMPLETO con argumentos. El login por
  // clave manda la clave dentro del JS de `eval`, y ese message se loguea
  // aguas arriba (rest/rutas/comun.ts, restServer.ts) — sin este saneo la
  // clave de un tenant termina en CloudWatch.
  it('un fallo del CLI NO expone los argumentos (la clave viaja en el JS de eval)', () => {
    const claveEnJs = `document.getElementById('clave').value="CLAVE_SUPER_SECRETA"`;
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error(`Command failed: agent-browser eval ${claveEnJs}`), {
        stderr: Buffer.from('page crashed'),
        stdout: Buffer.from(''),
      });
    });

    let capturado: unknown;
    try { browser.eval(claveEnJs); } catch (e) { capturado = e; }

    const mensaje = (capturado as Error).message;
    expect(mensaje).not.toContain('CLAVE_SUPER_SECRETA');
    // Sí debe decir QUÉ subcomando falló y la salida del CLI (que es segura).
    expect(mensaje).toContain('eval');
    expect(mensaje).toContain('page crashed');
  });

  it('el error de un fallo del CLI tampoco expone los argumentos al serializarlo', () => {
    const claveEnJs = `document.getElementById('clave').value="OTRA_CLAVE_SECRETA"`;
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error(`Command failed: agent-browser eval ${claveEnJs}`), {
        stderr: Buffer.from(''), stdout: Buffer.from(''),
      });
    });

    let capturado: unknown;
    try { browser.eval(claveEnJs); } catch (e) { capturado = e; }

    // Ni el message ni el stack (que incluye el message) deben traer la clave.
    expect(String((capturado as Error).message)).not.toContain('OTRA_CLAVE_SECRETA');
    expect(String((capturado as Error).stack)).not.toContain('OTRA_CLAVE_SECRETA');
  });

  // BLOQUEANTE 2 del pr-review: ErrorDeBrowser guardaba el error original de
  // execFileSync completo en `causa`, una propiedad propia y ENUMERABLE. Un
  // `console.error(err)` (como hace src/rest/auditoria.ts al no poder
  // escribir la auditoría) o `util.inspect(err)` imprime las props propias,
  // incluida `causa.message`, que trae el comando COMPLETO con la clave. Este
  // test es el que faltaba: nada de lo que expone el objeto (ni siquiera
  // vía inspección profunda) puede contener la clave.
  it('el error serializado (inspect/JSON de props propias) no filtra la clave del error original', () => {
    const claveEnJs = `document.getElementById('clave').value="CLAVE_FILTRADA_INSPECT"`;
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error(`Command failed: agent-browser eval ${claveEnJs}`), {
        stderr: Buffer.from(''),
        stdout: Buffer.from(''),
      });
    });

    let capturado: unknown;
    try { browser.eval(claveEnJs); } catch (e) { capturado = e; }

    const inspeccionado = util.inspect(capturado, { depth: 5 });
    expect(inspeccionado).not.toContain('CLAVE_FILTRADA_INSPECT');

    // JSON.stringify sólo serializa props propias enumerables (Error.message
    // no es enumerable por defecto, pero una `causa` guardada en el
    // constructor sí lo sería) — cubre el mismo riesgo por otra vía.
    expect(JSON.stringify(capturado)).not.toContain('CLAVE_FILTRADA_INSPECT');
  });

  // BLOQUEANTE 1 del pr-review: openWithPendingDialog decidía si tragar el
  // error mirando sólo el TEXTO (err.message/salida). En un timeout real de
  // execFileSync, `stderr`/`stdout` vienen vacíos (el proceso no llegó a
  // imprimir nada) y el `message` saneado de ErrorDeBrowser ya no repite
  // "ETIMEDOUT" — antes lo hacía porque exponía el message crudo de
  // execFileSync ("spawnSync agent-browser ETIMEDOUT"). Sin propagar
  // `code`/`signal`, la señal de timeout se pierde y el error se re-lanza,
  // rompiendo el flujo de certificado con confirm dialog.
  it('openWithPendingDialog NO relanza un timeout real (code ETIMEDOUT, sin texto reconocible)', () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync agent-browser ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        stderr: Buffer.from(''),
        stdout: Buffer.from(''),
      });
    });

    expect(() => browser.openWithPendingDialog('https://example.com')).not.toThrow();
  });

  it('openWithPendingDialog SÍ relanza un error con otro code (no es timeout ni dialog)', () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error('algo explotó'), {
        code: 'EPIPE',
        stderr: Buffer.from(''),
        stdout: Buffer.from(''),
      });
    });

    expect(() => browser.openWithPendingDialog('https://example.com')).toThrow(ErrorDeBrowser);
  });

  // BLOQUEANTE 3 del pr-review: evalPrivado manda el JS por stdin de
  // agent-browser (modo batch --json) en vez de por argv, para que la clave
  // tributaria no quede visible en ps/`/proc/<pid>/cmdline` del contenedor.
  describe('evalPrivado', () => {
    it('manda el comando por stdin via batch --json, no por argv', () => {
      mockExec.mockReturnValue(Buffer.from(JSON.stringify([
        { success: true, error: null, result: { result: undefined } },
      ])));

      browser.evalPrivado("document.getElementById('clave').value=\"secreta\"");

      expect(mockExec).toHaveBeenCalledWith(
        'agent-browser',
        ['batch', '--json'],
        expect.objectContaining({
          input: JSON.stringify([['eval', "document.getElementById('clave').value=\"secreta\""]]),
        })
      );
      // La clave NO debe aparecer en ningún argumento de argv.
      const [, argv] = mockExec.mock.calls[0];
      expect((argv as string[]).join(' ')).not.toContain('secreta');
    });

    it('antepone --session al subcomando batch cuando hay sessionId', () => {
      const browserConSesion = new Browser('11111111-1');
      mockExec.mockReturnValue(Buffer.from(JSON.stringify([
        { success: true, error: null, result: { result: 'ok' } },
      ])));

      browserConSesion.evalPrivado('1+1');

      expect(mockExec).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', '11111111-1', 'batch', '--json'],
        expect.any(Object)
      );
    });

    it('devuelve el valor de result.result, equivalente al retorno de eval() por argv', () => {
      mockExec.mockReturnValue(Buffer.from(JSON.stringify([
        { success: true, error: null, result: { result: 'SI' } },
      ])));

      expect(browser.evalPrivado("document.getElementById('myform') ? 'SI' : 'NO'")).toBe('SI');
    });

    it('si el comando falla dentro del batch (success:false), lanza ErrorDeBrowser sin exponer argumentos', () => {
      mockExec.mockReturnValue(Buffer.from(JSON.stringify([
        { success: false, error: 'page crashed', result: null },
      ])));

      let capturado: unknown;
      try {
        browser.evalPrivado("document.getElementById('clave').value=\"CLAVE_EN_BATCH\"");
      } catch (e) { capturado = e; }

      expect(capturado).toBeInstanceOf(ErrorDeBrowser);
      expect((capturado as Error).message).not.toContain('CLAVE_EN_BATCH');
      expect((capturado as Error).message).toContain('page crashed');
    });
  });
});
