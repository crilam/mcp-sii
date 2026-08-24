import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSesionTools } from '../../src/tools/bienesRaices';
import { ProveedorCredencialesRuntime } from '../../src/credencialesRuntime';
import { RegistroSesiones } from '../../src/registroSesiones';

// Patrón vigente en este repo para testear tools MCP: el SDK expone los
// handlers registrados en `server._registeredTools` (ver
// tests/tools/mipyme.test.ts), no hace falta espiar server.tool.
function armar(registro: RegistroSesiones<any>, credenciales: ProveedorCredencialesRuntime) {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerSesionTools(server, registro, credenciales);
  return { tools: (server as any)._registeredTools };
}

describe('sii_iniciar_sesion / sii_cerrar_sesion', () => {
  it('iniciar sesión con credenciales válidas guarda la credencial y autentica', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    const authenticateOnly = jest.fn().mockResolvedValue(undefined);
    const registro = {
      ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly, logout: jest.fn() }),
      olvidar: jest.fn(),
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
      olvidar: jest.fn(),
    } as unknown as RegistroSesiones<any>;

    const { tools } = armar(registro, proveedor);
    const resultado = await tools['sii_iniciar_sesion'].handler({ rut: '11.111.111-1', clave: 'mala' });

    const parsed = JSON.parse(resultado.content[0].text);
    expect(parsed).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
    // Credencial rechazada: no debe quedar guardada.
    await expect(proveedor.para('11.111.111-1')).rejects.toThrow();
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
});
