import { ejecutar } from '../../../src/rest/rutas/comun';
import { SesionesSimultaneas, LimiteDeConsultasSii, ServicioOcupado, EscrituraRechazadaPorSii } from '../../../src/erroresConsulta';

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
  // El bloqueo por sesiones simultáneas del SII sale con código propio y no
  // mezclado en el ERROR genérico. Reintentar sirve en los dos casos, así que lo
  // que cambia no es el comportamiento sino lo que se le puede decir a la
  // persona: "hay otra consulta en curso sobre este contribuyente" es accionable
  // —tiene otra pestaña abierta, o un colega está en el mismo caso—, "probá de
  // nuevo en unos minutos" no.
  it('SesionesSimultaneas sale como SESIONES_SIMULTANEAS con detalle', async () => {
    const respuesta = await ejecutar(async () => {
      throw new SesionesSimultaneas('el RUT 11111111-1 ya tiene demasiadas sesiones abiertas');
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({
      ok: false,
      error: 'SESIONES_SIMULTANEAS',
      detalle: 'el RUT 11111111-1 ya tiene demasiadas sesiones abiertas',
    });
  });

  // No hereda de LimitacionConocida —esto SÍ se arregla esperando—, así que no
  // puede caer en LIMITE_CONOCIDO, que el contrato declara como permanente.
  it('SesionesSimultaneas no se confunde con LIMITE_CONOCIDO', async () => {
    const respuesta = await ejecutar(async () => {
      throw new SesionesSimultaneas('demasiadas sesiones');
    });

    expect((respuesta.body as { error: string }).error).not.toBe('LIMITE_CONOCIDO');
    expect((respuesta.body as { error: string }).error).not.toBe('ERROR');
  });
  // El SII corta por volumen con su propio 429, y eso NO puede llegar como
  // ERROR: `ERROR` significa "reintentá", y reintentar de inmediato un corte por
  // volumen es exactamente lo que lo mantiene cortado.
  // Un rechazo de negocio del SII en una escritura es RECHAZO_SII, no ERROR:
  // reintentar no lo arregla, hay que corregir el motivo.
  it('EscrituraRechazadaPorSii sale como RECHAZO_SII con detalle', async () => {
    const respuesta = await ejecutar(async () => {
      throw new EscrituraRechazadaPorSii('El SII rechazó el acuse: RUT sin timbraje');
    });

    expect(respuesta.status).toBe(200);
    expect((respuesta.body as { error: string }).error).toBe('RECHAZO_SII');
    expect((respuesta.body as { detalle: string }).detalle).toMatch(/timbraje/);
  });

  it('LimiteDeConsultasSii sale como LIMITE_SII y no como ERROR', async () => {
    const respuesta = await ejecutar(async () => {
      throw new LimiteDeConsultasSii('El SII cortó las consultas por volumen');
    });

    expect(respuesta.status).toBe(200);
    expect((respuesta.body as { error: string }).error).toBe('LIMITE_SII');
    expect((respuesta.body as { detalle: string }).detalle).toMatch(/volumen/);
  });

  // Simétrico al de arriba, y por el mismo motivo: `SERVICIO_OCUPADO` es
  // NUESTRA cola llena, no el SII. Como `ERROR` el consumidor reintenta al
  // instante contra una cola que justamente está llena; con su código propio
  // sabe que espera segundos, no los minutos de `LIMITE_SII`.
  it('ServicioOcupado sale como SERVICIO_OCUPADO y no como ERROR', async () => {
    const respuesta = await ejecutar(async () => {
      throw new ServicioOcupado('Hay 12 consultas de indicadores en curso');
    });

    expect(respuesta.status).toBe(200);
    expect((respuesta.body as { error: string }).error).toBe('SERVICIO_OCUPADO');
    expect((respuesta.body as { detalle: string }).detalle).toMatch(/12 consultas/);
  });

  // Tampoco puede caer en LIMITE_CONOCIDO, que el contrato declara PERMANENTE:
  // esto se arregla esperando, así que confundirlos haría que el consumidor
  // abandone una consulta que iba a funcionar en unos minutos.
  it('LimiteDeConsultasSii no se confunde con LIMITE_CONOCIDO', async () => {
    const respuesta = await ejecutar(async () => {
      throw new LimiteDeConsultasSii('corte por volumen');
    });

    expect((respuesta.body as { error: string }).error).not.toBe('LIMITE_CONOCIDO');
  });
});
