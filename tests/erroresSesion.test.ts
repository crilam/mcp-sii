import { clasificarErrorCredenciales, conErroresDeSesion, SesionNoIniciada } from '../src/erroresSesion';

describe('conErroresDeSesion', () => {
  it('traduce el rechazo de credenciales no encontradas a SesionNoIniciada', async () => {
    await expect(
      conErroresDeSesion(() => Promise.reject(new Error('No hay sesión iniciada para el RUT 11.111.111-1. Llamá sii_iniciar_sesion primero.')))
    ).rejects.toThrow(SesionNoIniciada);
  });

  it('deja pasar el resultado de éxito sin tocarlo', async () => {
    const resultado = await conErroresDeSesion(() => Promise.resolve('ok'));
    expect(resultado).toBe('ok');
  });

  it('deja pasar sin traducir un error que no es de sesión', async () => {
    await expect(
      conErroresDeSesion(() => Promise.reject(new Error('otro fallo, no de sesión')))
    ).rejects.toThrow('otro fallo, no de sesión');
  });
});

describe('clasificarErrorCredenciales', () => {
  it('clasifica el rechazo de autenticación del SII como CREDENCIALES_INVALIDAS', () => {
    const error = new Error('El SII rechazó la autenticación: clave incorrecta');
    expect(clasificarErrorCredenciales(error)).toBe('CREDENCIALES_INVALIDAS');
  });

  it('clasifica cualquier otro error como ERROR', () => {
    expect(clasificarErrorCredenciales(new Error('timeout de red'))).toBe('ERROR');
  });

  it('clasifica un valor que no es Error como ERROR', () => {
    expect(clasificarErrorCredenciales('algo raro')).toBe('ERROR');
  });
});
