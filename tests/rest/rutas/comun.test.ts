import { ejecutar } from '../../../src/rest/rutas/comun';

describe('ejecutar', () => {
  it('objeto: spreadea flat junto a ok:true', async () => {
    const respuesta = await ejecutar(() => Promise.resolve({ filas: [1, 2] }));
    expect(respuesta).toEqual({ status: 200, body: { ok: true, filas: [1, 2] } });
  });

  it('array: se envuelve bajo `datos`, no se spreadea con índices numéricos', async () => {
    const respuesta = await ejecutar(() => Promise.resolve([{ id: 1 }, { id: 2 }]));
    expect(respuesta).toEqual({ status: 200, body: { ok: true, datos: [{ id: 1 }, { id: 2 }] } });
  });

  it('array vacío: sigue siendo {ok:true, datos:[]}, no {ok:true} a secas', async () => {
    const respuesta = await ejecutar(() => Promise.resolve([]));
    expect(respuesta).toEqual({ status: 200, body: { ok: true, datos: [] } });
  });

  it('error de credenciales: {ok:false, error}', async () => {
    const respuesta = await ejecutar(() =>
      Promise.reject(new Error('El SII rechazó la autenticación: clave incorrecta'))
    );
    expect(respuesta).toEqual({ status: 200, body: { ok: false, error: 'CREDENCIALES_INVALIDAS' } });
  });
});
