import { validarClave } from '../src/httpServer';
import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';
import { RegistroSesiones } from '../src/registroSesiones';

function armarRegistro(sesion: { authenticateOnly: jest.Mock; logout: jest.Mock }) {
  return {
    ejecutar: (_rut: string, fn: any) => fn(sesion),
  } as unknown as RegistroSesiones<any>;
}

describe('validarClave', () => {
  it('clave correcta: responde ok:true y deja logout+borrar hechos', async () => {
    const authenticateOnly = jest.fn().mockResolvedValue(undefined);
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'secreta', registro, credenciales);

    expect(resultado).toEqual({ ok: true });
    expect(logout).toHaveBeenCalled();
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow();
  });

  it('clave rechazada por el SII: responde CREDENCIALES_INVALIDAS y limpia igual', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(
      new Error('El SII rechazó la autenticación: clave incorrecta')
    );
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'mala', registro, credenciales);

    expect(resultado).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
    expect(logout).toHaveBeenCalled();
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow();
  });

  it('fallo de infraestructura: responde ERROR y limpia igual', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'x', registro, credenciales);

    expect(resultado).toEqual({ ok: false, error: 'ERROR' });
    expect(logout).toHaveBeenCalled();
  });

  it('logout corre aunque authenticateOnly lance (try/finally, no encadenado)', async () => {
    const orden: string[] = [];
    const authenticateOnly = jest.fn().mockImplementation(async () => {
      orden.push('authenticateOnly');
      throw new Error('boom');
    });
    const logout = jest.fn().mockImplementation(async () => {
      orden.push('logout');
    });
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    await validarClave('11.111.111-1', 'x', registro, credenciales);

    expect(orden).toEqual(['authenticateOnly', 'logout']);
  });
});
