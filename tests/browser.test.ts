import { execFileSync } from 'child_process';
import { Browser } from '../src/browser';

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

  it('eval ya no necesita escapar comillas manualmente (van como argumento propio)', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.eval('document.title === "algo"');
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser',
      ['eval', 'document.title === "algo"'],
      expect.any(Object)
    );
  });
});
