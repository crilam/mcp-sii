import { ejecutar } from '../../../src/rest/rutas/comun';
import {
  SesionesSimultaneas, LimiteDeConsultasSii, ServicioOcupado, EscrituraRechazadaPorSii,
  EmpresaNoAutorizada, SelectorEmpresasVacio, LimitacionConocida, RecursoNoEncontrado,
  PortalSiiNoDisponible,
} from '../../../src/erroresConsulta';

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

  // El bug real: el portal mipyme devuelve su propia página de error interno
  // («Error al contribuyente» / «no se puede responder a sus requerimientos»)
  // en vez del historial pedido, y antes de este código un parser que sólo
  // sabía leer filas la interpretaba como "cero documentos". Código propio y
  // NO LIMITE_CONOCIDO: esa familia significa "esto no se arregla
  // reintentando", justo lo contrario del propio aviso del SII.
  it('PortalSiiNoDisponible sale como SII_NO_DISPONIBLE con detalle, no como LIMITE_CONOCIDO ni ERROR', async () => {
    const respuesta = await ejecutar(async () => {
      throw new PortalSiiNoDisponible(
        'El portal mipyme respondió con su página de error (código 04.77.113.29.408.51).'
      );
    });

    expect(respuesta.status).toBe(200);
    expect((respuesta.body as { error: string }).error).toBe('SII_NO_DISPONIBLE');
    expect((respuesta.body as { detalle: string }).detalle).toMatch(/04\.77\.113\.29\.408\.51/);
    expect((respuesta.body as { error: string }).error).not.toBe('LIMITE_CONOCIDO');
    expect((respuesta.body as { error: string }).error).not.toBe('ERROR');
  });

  // El caso que motivó EmpresaNoAutorizada / SelectorEmpresasVacio: el selector
  // de empresas del portal mipyme es un permiso a nivel de PERSONA, no de
  // empresa. Antes de estos dos tipos, `resolverEmpresa`/`parseEmpresas`
  // lanzaban un Error pelado que llegaba acá como `ERROR` sin `detalle` — el
  // tenant no podía diagnosticar el fallo y, como `ERROR` se trata como
  // transitorio, reintentaba para siempre un pedido que nunca iba a funcionar.
  describe('EmpresaNoAutorizada / SelectorEmpresasVacio', () => {
    it('SelectorEmpresasVacio (selector vacío) sale como EMPRESA_NO_AUTORIZADA con detalle', async () => {
      const respuesta = await ejecutar(async () => {
        throw new SelectorEmpresasVacio(
          'El RUT autenticado no tiene ninguna empresa en su selector del portal mipyme.'
        );
      });

      expect(respuesta.status).toBe(200);
      expect(respuesta.body).toEqual({
        ok: false,
        error: 'EMPRESA_NO_AUTORIZADA',
        detalle: 'El RUT autenticado no tiene ninguna empresa en su selector del portal mipyme.',
      });
    });

    it('EmpresaNoAutorizada (empresa ausente de un selector no vacío) sale como EMPRESA_NO_AUTORIZADA con detalle', async () => {
      const respuesta = await ejecutar(async () => {
        throw new EmpresaNoAutorizada(
          'El RUT autenticado no tiene a 44444444-4 entre las empresas de su selector del ' +
          'portal mipyme (trae 3 empresas distintas).'
        );
      });

      expect(respuesta.status).toBe(200);
      expect((respuesta.body as { error: string }).error).toBe('EMPRESA_NO_AUTORIZADA');
      expect((respuesta.body as { detalle: string }).detalle).toMatch(/trae 3 empresas distintas/);
    });

    // Las dos son subclases de LimitacionConocida: no pueden colapsar en
    // LIMITE_CONOCIDO (el orden de los `instanceof` en `ejecutar` decide) ni en
    // ERROR (que el contrato trata como transitorio y reintentable).
    it('no se confunden con LIMITE_CONOCIDO ni con ERROR', async () => {
      const vacio = await ejecutar(async () => { throw new SelectorEmpresasVacio('vacío'); });
      const ausente = await ejecutar(async () => { throw new EmpresaNoAutorizada('ausente'); });

      for (const respuesta of [vacio, ausente]) {
        expect((respuesta.body as { error: string }).error).not.toBe('LIMITE_CONOCIDO');
        expect((respuesta.body as { error: string }).error).not.toBe('ERROR');
      }
    });

    /*
     * Toda la familia de LimitacionConocida en un solo caso, porque acá el
     * orden de los `instanceof` en `ejecutar` es lo único que separa un código
     * de otro: las cuatro clases son la misma cadena de herencia, y la clase
     * madre —que va última— matchea a todas. Mover ese bloque unas líneas hacia
     * arriba colapsaría las tres específicas en LIMITE_CONOCIDO sin que ningún
     * test que mire una sola clase se entere.
     *
     * `LimitacionConocida` pelada tiene que seguir dando LIMITE_CONOCIDO: es la
     * que representa "el SII no puede darnos esto por un límite que ya
     * conocemos", y perderla dejaría a los tres casos permanentes que no son
     * ninguna de las subclases saliendo como ERROR, o sea reintentables.
     */
    it.each([
      [() => new RecursoNoEncontrado('no existe'), 'NO_ENCONTRADO'],
      [() => new SelectorEmpresasVacio('selector vacío'), 'EMPRESA_NO_AUTORIZADA'],
      [() => new EmpresaNoAutorizada('empresa ausente'), 'EMPRESA_NO_AUTORIZADA'],
      [() => new LimitacionConocida('mes con más de 100 boletas'), 'LIMITE_CONOCIDO'],
    ] as [() => Error, string][])('la familia de LimitacionConocida no colapsa: %# -> %s', async (crear, codigo) => {
      const respuesta = await ejecutar(async () => { throw crear(); });

      expect((respuesta.body as { error: string }).error).toBe(codigo);
    });
  });

  // Antes de esto, cualquier excepción sin clasificar salía como
  // `{ok:false,error:'ERROR'}` PELADO: sin `detalle`, un cliente no tenía sobre
  // qué actuar ni qué reportar. Ver el comentario de la rama en comun.ts.
  describe('rama sin clasificar (ERROR)', () => {
    it('siempre adjunta detalle, aunque el código siga siendo ERROR', async () => {
      const respuesta = await ejecutar(async () => {
        throw new Error('el portal devolvió algo que no se pudo interpretar');
      });

      expect(respuesta).toEqual({
        status: 200,
        body: {
          ok: false,
          error: 'ERROR',
          detalle: 'el portal devolvió algo que no se pudo interpretar',
        },
      });
    });

    it('redacta patrones campo=valor / campo: valor cuyo nombre es un secreto conocido', async () => {
      const respuesta = await ejecutar(async () => {
        throw new Error('Command failed: cli --rut 11111111-1 --clave=miClaveSecreta123 --modo x');
      });

      const detalle = (respuesta.body as { detalle: string }).detalle;
      expect(detalle).not.toContain('miClaveSecreta123');
      expect(detalle).toContain('clave=[REDACTADO]');
    });

    it('trunca un mensaje larguísimo en vez de volcarlo entero', async () => {
      const respuesta = await ejecutar(async () => {
        throw new Error('x'.repeat(1000));
      });

      const detalle = (respuesta.body as { detalle: string }).detalle;
      expect(detalle.length).toBeLessThan(400);
    });
  });
});
