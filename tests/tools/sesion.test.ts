import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSesionTools } from '../../src/tools/bienesRaices';
import { ProveedorCredencialesRuntime } from '../../src/credencialesRuntime';
import { RegistroSesiones } from '../../src/registroSesiones';
import { LectorClave, LlaveroNoSoportado } from '../../src/claveLlavero';

// Patrón vigente en este repo para testear tools MCP: el SDK expone los
// handlers registrados en `server._registeredTools` (ver
// tests/tools/mipyme.test.ts), no hace falta espiar server.tool.
function armar(registro: RegistroSesiones<any>, credenciales: ProveedorCredencialesRuntime, lectorClave?: LectorClave) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerSesionTools(server, registro, credenciales, lectorClave);
  return { tools: (server as any)._registeredTools };
}

describe('sii_iniciar_sesion / sii_cerrar_sesion', () => {
  it('iniciar sesión con credenciales válidas guarda la credencial y autentica', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    const authenticateOnly = jest.fn().mockResolvedValue(undefined);
    const registro = {
      ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly, logout: jest.fn() }),
      cerrarYOlvidar: jest.fn(),
    } as unknown as RegistroSesiones<any>;

    const { tools } = armar(registro, proveedor);
    const resultado = await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1', clave: 'secreta' });

    expect(authenticateOnly).toHaveBeenCalled();
    expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: true, rut: '11.111.111-1' });
    await expect(proveedor.para('11.111.111-1')).resolves.toMatchObject({ clave: 'secreta' });
  });

  it('iniciar sesión con credenciales rechazadas por el SII devuelve CREDENCIALES_INVALIDAS', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    const authenticateOnly = jest.fn().mockRejectedValue(new Error('El SII rechazó la autenticación: clave incorrecta'));
    const registro = {
      ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly, logout: jest.fn() }),
      cerrarYOlvidar: jest.fn(),
    } as unknown as RegistroSesiones<any>;

    const { tools } = armar(registro, proveedor);
    const resultado = await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1', clave: 'mala' });

    const parsed = JSON.parse(resultado.content[0].text);
    expect(parsed).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
    // Credencial rechazada: no debe quedar guardada.
    await expect(proveedor.para('11.111.111-1')).rejects.toThrow();
  });

  // Sin desalojar, la sesión fallida quedaba cacheada con la clave mala (la
  // config se captura al construir la sesión), así que reintentar con la clave
  // corregida seguía fallando hasta un sii_cerrar_sesion. Y desde que cada
  // sesión tiene contexto propio, cada intento fallido dejaba además un proceso
  // y un perfil en disco sin dueño.
  it('un login fallido desaloja la sesión, para que el reintento no reuse la clave mala', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    const authenticateOnly = jest.fn().mockRejectedValue(
      new Error('El SII rechazó la autenticación: RUT o clave incorrectos.')
    );
    const cerrarYOlvidar = jest.fn();
    const registro = {
      ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly, logout: jest.fn() }),
      cerrarYOlvidar,
    } as unknown as RegistroSesiones<any>;

    const { tools } = armar(registro, proveedor);
    await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1', clave: 'mala' });

    expect(cerrarYOlvidar).toHaveBeenCalledWith('11.111.111-1', expect.any(Function));
  });

  it('cerrar sesión hace logout y borra la credencial del proveedor', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    proveedor.guardar('11.111.111-1', 'secreta');
    const logout = jest.fn().mockResolvedValue(undefined);
    // `cerrarYOlvidar` corre el logout Y el desalojo dentro del turno de la cola
    // del RUT: el desalojo cierra el navegador y borra su perfil, así que fuera
    // de la cola podría arrancarle el contexto a otra operación en vuelo.
    const cerrarYOlvidar = jest.fn(async (_rut: string, cerrar: any) => {
      await cerrar({ logout });
    });
    const registro = { cerrarYOlvidar } as unknown as RegistroSesiones<any>;

    const { tools } = armar(registro, proveedor);
    await tools['sii_cerrar_sesion'].handler({ rut: '11.111.111-1' });

    expect(cerrarYOlvidar).toHaveBeenCalledWith('11.111.111-1', expect.any(Function));
    expect(logout).toHaveBeenCalled();
    await expect(proveedor.para('11.111.111-1')).rejects.toThrow();
  });

  describe('clave desde el Llavero', () => {
    function registroQueAutentica() {
      const authenticateOnly = jest.fn().mockResolvedValue(undefined);
      const registro = {
        ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly, logout: jest.fn() }),
        cerrarYOlvidar: jest.fn(),
      } as unknown as RegistroSesiones<any>;
      return { registro, authenticateOnly };
    }

    it('sin clave en los parámetros, la lee del Llavero y autentica con ella', async () => {
      const proveedor = new ProveedorCredencialesRuntime();
      const { registro, authenticateOnly } = registroQueAutentica();
      const lector = jest.fn().mockResolvedValue('delLlavero');

      const { tools } = armar(registro, proveedor, lector);
      const resultado = await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1' });

      expect(lector).toHaveBeenCalledWith('11.111.111-1');
      expect(authenticateOnly).toHaveBeenCalled();
      expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: true, rut: '11.111.111-1' });
      await expect(proveedor.para('11.111.111-1')).resolves.toMatchObject({ clave: 'delLlavero' });
    });

    it('con clave en los parámetros no consulta el Llavero', async () => {
      const proveedor = new ProveedorCredencialesRuntime();
      const { registro } = registroQueAutentica();
      const lector = jest.fn();

      const { tools } = armar(registro, proveedor, lector);
      await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1', clave: 'explicita' });

      expect(lector).not.toHaveBeenCalled();
      await expect(proveedor.para('11.111.111-1')).resolves.toMatchObject({ clave: 'explicita' });
    });

    // Un intento contra el SII sin clave igual cuenta para el límite de sesiones
    // simultáneas del RUT, así que ni se intenta.
    it('si el Llavero no tiene la clave, devuelve CLAVE_NO_EN_LLAVERO sin tocar el SII', async () => {
      const proveedor = new ProveedorCredencialesRuntime();
      const { registro, authenticateOnly } = registroQueAutentica();

      const { tools } = armar(registro, proveedor, jest.fn().mockResolvedValue(undefined));
      const resultado = await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1' });

      expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: false, error: 'CLAVE_NO_EN_LLAVERO' });
      expect(authenticateOnly).not.toHaveBeenCalled();
      await expect(proveedor.para('11.111.111-1')).rejects.toThrow();
    });

    it('una clave vacía o de espacios se trata como ausente y se lee del Llavero', async () => {
      const proveedor = new ProveedorCredencialesRuntime();
      const { registro } = registroQueAutentica();
      const lector = jest.fn().mockResolvedValue('delLlavero');

      const { tools } = armar(registro, proveedor, lector);
      await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1', clave: '  ' });

      expect(lector).toHaveBeenCalled();
      await expect(proveedor.para('11.111.111-1')).resolves.toMatchObject({ clave: 'delLlavero' });
    });

    it('un RUT sin cuerpo ni dígito verificador devuelve RUT_INVALIDO sin consultar el Llavero', async () => {
      const proveedor = new ProveedorCredencialesRuntime();
      const { registro, authenticateOnly } = registroQueAutentica();
      const lector = jest.fn();

      const { tools } = armar(registro, proveedor, lector);
      const resultado = await tools['sii_iniciar_sesion'].handler({ rut: '-' });

      expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: false, error: 'RUT_INVALIDO' });
      expect(lector).not.toHaveBeenCalled();
      expect(authenticateOnly).not.toHaveBeenCalled();
    });

    it('fuera de macOS devuelve LLAVERO_NO_SOPORTADO', async () => {
      const proveedor = new ProveedorCredencialesRuntime();
      const { registro } = registroQueAutentica();

      const { tools } = armar(registro, proveedor, jest.fn().mockRejectedValue(new LlaveroNoSoportado('x')));
      const resultado = await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1' });

      expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: false, error: 'LLAVERO_NO_SOPORTADO' });
    });

    it('si el Llavero falla, devuelve LLAVERO_NO_DISPONIBLE sin tocar el SII', async () => {
      const proveedor = new ProveedorCredencialesRuntime();
      const { registro, authenticateOnly } = registroQueAutentica();

      const { tools } = armar(registro, proveedor, jest.fn().mockRejectedValue(new Error('bloqueado')));
      const resultado = await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1' });

      expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: false, error: 'LLAVERO_NO_DISPONIBLE' });
      expect(authenticateOnly).not.toHaveBeenCalled();
    });
  });
});
