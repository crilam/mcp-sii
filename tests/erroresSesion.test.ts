import { conErroresDeSesion, SesionNoIniciada } from '../src/erroresSesion';

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
