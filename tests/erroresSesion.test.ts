import { clasificarErrorCredenciales, conErroresDeSesion, envolverParaMcp, SesionNoIniciada } from '../src/erroresSesion';

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

describe('envolverParaMcp', () => {
  it('envuelve el resultado exitoso en {content}', async () => {
    const resultado = await envolverParaMcp(() => Promise.resolve({ filas: [1, 2] }));
    expect(JSON.parse(resultado.content[0].text)).toEqual({ filas: [1, 2] });
  });

  it('traduce SesionNoIniciada a {ok:false, error:SESION_NO_INICIADA}', async () => {
    const resultado = await envolverParaMcp(() =>
      Promise.reject(new Error('No hay sesión iniciada para el RUT 1. Llamá sii_iniciar_sesion primero.'))
    );
    expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('deja pasar cualquier otro error sin traducirlo', async () => {
    await expect(envolverParaMcp(() => Promise.reject(new Error('otro fallo')))).rejects.toThrow('otro fallo');
  });
});
