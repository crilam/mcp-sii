import { cerrarSesionDeScript } from '../../src/scripts/cerrarSesionDeScript';
import { SessionManager } from '../../src/session';

// El invariante que estos tests fijan es el que justifica que la función use DOS
// try separados en vez de uno solo: la limpieza local no puede quedar
// condicionada a que el portal del SII responda. Sin el test, cualquiera
// "simplifica" a un try único y la garantía se pierde en silencio — el síntoma
// sería un cookie jar con credenciales vivas quedando en disco justo los días en
// que el SII anda mal.
function sesionFalsa(over: Partial<Record<'logout' | 'cerrarContexto', jest.Mock>> = {}) {
  return {
    logout: over.logout ?? jest.fn().mockResolvedValue(undefined),
    cerrarContexto: over.cerrarContexto ?? jest.fn(),
  } as unknown as SessionManager;
}

describe('cerrarSesionDeScript', () => {
  // Se silencia el console.error: los avisos de fallo son parte del diseño (la
  // función reporta y sigue), y ensuciarían la salida de la corrida.
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('cierra la sesión del SII antes que el contexto local', async () => {
    const orden: string[] = [];
    const sesion = sesionFalsa({
      logout: jest.fn().mockImplementation(async () => { orden.push('logout'); }),
      cerrarContexto: jest.fn().mockImplementation(() => { orden.push('contexto'); }),
    });

    await cerrarSesionDeScript(sesion);

    // El orden importa: `cerrarContexto` borra el perfil y el cookie jar, o sea
    // las credenciales con las que `logout` tiene que hablarle al SII.
    expect(orden).toEqual(['logout', 'contexto']);
  });

  // Éste es el que importa: si el SII no responde, el perfil y el cookie jar
  // TIENEN que borrarse igual, porque son credenciales de sesión en disco.
  it('cierra el contexto local aunque el logout falle', async () => {
    const cerrarContexto = jest.fn();
    const sesion = sesionFalsa({
      logout: jest.fn().mockRejectedValue(new Error('el SII no responde')),
      cerrarContexto,
    });

    await expect(cerrarSesionDeScript(sesion)).resolves.toBeUndefined();

    expect(cerrarContexto).toHaveBeenCalled();
  });

  // Se llama desde un `finally`: si lanzara, taparía el error real que se estaba
  // propagando y el script reportaría la causa equivocada.
  it('no propaga aunque fallen los dos pasos', async () => {
    const sesion = sesionFalsa({
      logout: jest.fn().mockRejectedValue(new Error('logout falló')),
      cerrarContexto: jest.fn().mockImplementation(() => { throw new Error('cierre falló'); }),
    });

    await expect(cerrarSesionDeScript(sesion)).resolves.toBeUndefined();
  });
});
