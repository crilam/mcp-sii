import { registrarRutasSesion, validarClave } from '../../../src/rest/rutas/sesion';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';

function armarRegistro(sesion: { authenticateOnly: jest.Mock; logout: jest.Mock }) {
  return {
    ejecutarPassThrough: async (_rut: string, preparar: () => void, finalizar: () => void, fn: any) => {
      preparar();
      try {
        return await fn(sesion);
      } finally {
        finalizar();
      }
    },
  } as unknown as RegistroSesiones<any>;
}

function armarRouter(sesion: { authenticateOnly: jest.Mock; logout: jest.Mock }) {
  const rutas = new Map<string, Function>();
  registrarRutasSesion(rutas as any, armarRegistro(sesion), new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasSesion', () => {
  it('registra POST /v1/sesion/validar-clave', () => {
    const rutas = armarRouter({ authenticateOnly: jest.fn(), logout: jest.fn() });
    expect([...rutas.keys()]).toEqual(['POST /v1/sesion/validar-clave']);
  });

  it('clave correcta: responde {ok:true}', async () => {
    const rutas = armarRouter({
      authenticateOnly: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    });
    const respuesta = await rutas.get('POST /v1/sesion/validar-clave')!({ rut: '11.111.111-1', clave: 'x' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true } });
  });

  it('body inválido devuelve 400', async () => {
    const rutas = armarRouter({ authenticateOnly: jest.fn(), logout: jest.fn() });
    const respuesta = await rutas.get('POST /v1/sesion/validar-clave')!({ rut: '11.111.111-1' });
    expect(respuesta.status).toBe(400);
  });
});

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

  // El mensaje EXACTO que produce session.ts cuando el portal dice que la clave
  // no es correcta. El test de arriba usa un texto parecido pero inventado: si
  // alguien cambia el mensaje real y rompe la clasificación, este lo atrapa.
  it('el mensaje real de clave incorrecta clasifica como CREDENCIALES_INVALIDAS', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(
      new Error('El SII rechazó la autenticación: RUT o clave incorrectos.')
    );
    const registro = armarRegistro({ authenticateOnly, logout: jest.fn().mockResolvedValue(undefined) });

    const resultado = await validarClave(
      '11.111.111-1', 'mala', registro, new ProveedorCredencialesRuntime());

    expect(resultado).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
  });

  // Cuando no se pudo VERIFICAR la sesión (cola de espera, caída del portal,
  // lectura de cookies fallida), la clave puede ser perfectamente válida. Tiene
  // que salir como ERROR: con CREDENCIALES_INVALIDAS el tenant borraría una
  // credencial que servía.
  it('no poder verificar la sesión responde ERROR, no CREDENCIALES_INVALIDAS', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(
      new Error(
        'El SII no estableció una sesión y no informó que la clave sea incorrecta. ' +
        'Puede ser una caída del portal, la cola de espera o un bloqueo temporal; reintentá.'
      )
    );
    const registro = armarRegistro({ authenticateOnly, logout: jest.fn().mockResolvedValue(undefined) });

    const resultado = await validarClave(
      '11.111.111-1', 'buena', registro, new ProveedorCredencialesRuntime());

    expect(resultado).toEqual({ ok: false, error: 'ERROR' });
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

  it('clave correcta pero logout falla: sigue respondiendo ok:true (logout no pisa el resultado)', async () => {
    const authenticateOnly = jest.fn().mockResolvedValue(undefined);
    const logout = jest.fn().mockRejectedValue(new Error('ETIMEDOUT en logout'));
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'secreta', registro, credenciales);

    expect(resultado).toEqual({ ok: true });
  });

  it('clave rechazada y logout también falla: conserva CREDENCIALES_INVALIDAS, no ERROR', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(
      new Error('El SII rechazó la autenticación: clave incorrecta')
    );
    const logout = jest.fn().mockRejectedValue(new Error('ETIMEDOUT en logout'));
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'mala', registro, credenciales);

    expect(resultado).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
  });

  it('guarda y borra la credencial dentro del mismo ejecutarPassThrough (atómico por RUT, no pasos sueltos)', async () => {
    const authenticateOnly = jest.fn().mockImplementation(async () => {
      // Mientras authenticateOnly corre, la credencial ya debe estar guardada.
      await expect(credenciales.para('11.111.111-1')).resolves.toMatchObject({ clave: 'secreta' });
    });
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    await validarClave('11.111.111-1', 'secreta', registro, credenciales);

    // Y después de terminar, no queda nada guardado.
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow();
  });
});
