import { execFile } from 'child_process';
import { leerClaveDelLlavero, servicioLlavero, LlaveroNoSoportado, rutValidoParaLlavero } from '../src/claveLlavero';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
const execFileMock = execFile as unknown as jest.Mock;

function responder(error: any, stdout = '') {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => cb(error, stdout, ''));
}

describe('leerClaveDelLlavero', () => {
  const plataforma = process.platform;
  const orig = { ...process.env };
  beforeEach(() => {
    execFileMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SII_LLAVERO_SERVICIO;
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: plataforma });
    process.env = { ...orig };
  });

  it('consulta el servicio mcp-sii con el RUT normalizado como cuenta, sin shell', async () => {
    responder(null, 'secreta\n');
    await expect(leerClaveDelLlavero('11.111.111-1')).resolves.toBe('secreta');
    expect(execFileMock).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'mcp-sii', '-a', '111111111', '-w'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('respeta SII_LLAVERO_SERVICIO', async () => {
    process.env.SII_LLAVERO_SERVICIO = 'otro-servicio';
    responder(null, 'x\n');
    await leerClaveDelLlavero('11111111-1');
    expect(servicioLlavero()).toBe('otro-servicio');
    expect(execFileMock.mock.calls[0][1]).toContain('otro-servicio');
  });

  it('devuelve undefined si el ítem no existe (salida 44)', async () => {
    responder(Object.assign(new Error('not found'), { code: 44 }));
    await expect(leerClaveDelLlavero('11111111-1')).resolves.toBeUndefined();
  });

  it('propaga otros errores con un mensaje propio', async () => {
    responder(Object.assign(new Error('User interaction is not allowed'), { code: 36 }));
    await expect(leerClaveDelLlavero('11111111-1')).rejects.toThrow('No se pudo leer el Llavero de macOS');
  });

  it('fuera de macOS rechaza con LlaveroNoSoportado sin ejecutar nada', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(leerClaveDelLlavero('11111111-1')).rejects.toBeInstanceOf(LlaveroNoSoportado);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('un RUT que normaliza a vacío no llega a security', async () => {
    await expect(leerClaveDelLlavero('-')).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('stdout vacío es ausencia de clave', async () => {
    responder(null, '');
    await expect(leerClaveDelLlavero('11111111-1')).resolves.toBeUndefined();
  });

  it('quita el fin de línea CRLF', async () => {
    responder(null, 'secreta\r\n');
    await expect(leerClaveDelLlavero('11111111-1')).resolves.toBe('secreta');
  });

  it('un timeout (error sin código numérico) es error, no ausencia', async () => {
    responder(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }));
    await expect(leerClaveDelLlavero('11111111-1')).rejects.toThrow('No se pudo leer el Llavero de macOS');
  });
});

describe('rutValidoParaLlavero', () => {
  it.each([['11.111.111-1', true], ['76019824-K', true], ['-', false], ['', false], ['abc', false], ['1', false]])(
    '%s → %s', (rut, esperado) => expect(rutValidoParaLlavero(rut)).toBe(esperado));
});
