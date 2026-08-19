import { RegistroSesiones } from '../src/registroSesiones';

describe('RegistroSesiones', () => {
  it('crea UNA sesión por RUT y la reusa entre llamadas del mismo RUT', async () => {
    let creadas = 0;
    // La factory devuelve un objeto marcado, para distinguir instancias.
    const registro = new RegistroSesiones((rut: string) => ({ rut, id: ++creadas }));

    const a1 = await registro.ejecutar('rut-1', async s => s);
    const a2 = await registro.ejecutar('rut-1', async s => s);

    // Reusa: la segunda llamada NO crea otra sesión. Recrearla obligaría a
    // reautenticar en cada consulta y perdería el estado de empresa del SII.
    expect(a1).toBe(a2);
    expect(creadas).toBe(1);
  });

  it('crea sesiones distintas para RUTs distintos', async () => {
    const registro = new RegistroSesiones((rut: string) => ({ rut }));

    const a = await registro.ejecutar('11111111-1', async s => s);
    const b = await registro.ejecutar('22222222-2', async s => s);

    expect(a).not.toBe(b);
    // La factory recibe el RUT ya normalizado: es la clave con la que se
    // cachea y se serializa, la misma para cualquier formato de entrada.
    expect(a.rut).toBe('111111111');
    expect(b.rut).toBe('222222222');
  });

  // El orden de entrada/salida de cada operación, para ver si se solaparon.
  function traza() {
    const eventos: string[] = [];
    const op = (nombre: string, ms: number) => async () => {
      eventos.push(`${nombre}:in`);
      await new Promise(r => setTimeout(r, ms));
      eventos.push(`${nombre}:out`);
    };
    return { eventos, op };
  }

  it('serializa operaciones del MISMO RUT: es el bloqueo del SII', async () => {
    const registro = new RegistroSesiones((rut: string) => ({ rut }));
    const { eventos, op } = traza();

    await Promise.all([
      registro.ejecutar('rut-1', op('A', 30)),
      registro.ejecutar('rut-1', op('B', 1)),
    ]);

    // Dos sesiones simultáneas del mismo RUT bloquean al SII, así que van en
    // serie: nunca A:in y B:in antes de A:out.
    expect(eventos).toEqual(['A:in', 'A:out', 'B:in', 'B:out']);
  });

  it('corre en paralelo operaciones de RUTs distintos: no compiten en el SII', async () => {
    const registro = new RegistroSesiones((rut: string) => ({ rut }));
    const { eventos, op } = traza();

    await Promise.all([
      registro.ejecutar('rut-1', op('A', 20)),
      registro.ejecutar('rut-2', op('B', 20)),
    ]);

    // Las dos entran antes de que cualquiera salga: es lo que habilita
    // multi-servicio sin que un cliente degrade a otro.
    expect(eventos.slice(0, 2).sort()).toEqual(['A:in', 'B:in']);
  });

  it('admite una factory asíncrona: la credencial puede venir de Secrets Manager', async () => {
    const registro = new RegistroSesiones(async (rut: string) => {
      await new Promise(r => setTimeout(r, 5));
      return { rut };
    });

    // fn recibe la sesión YA RESUELTA, no una promesa: si el registro cacheara
    // la promesa sin esperarla, `sesion.rut` sería undefined acá.
    const rutVisto = await registro.ejecutar('11111111-1', async sesion => sesion.rut);

    expect(rutVisto).toBe('111111111');
  });

  it('con factory asíncrona y llamadas concurrentes del mismo RUT, crea UNA sola sesión', async () => {
    // Sin la serialización por RUT, dos llamadas concurrentes verían la caché
    // vacía a la vez y ambas crearían sesión —dos sesiones del mismo RUT es el
    // bloqueo del SII—. La cola por RUT lo evita: la creación queda dentro del
    // turno.
    let creadas = 0;
    const registro = new RegistroSesiones(async (rut: string) => {
      await new Promise(r => setTimeout(r, 10));
      return { rut, id: ++creadas };
    });

    const [a, b] = await Promise.all([
      registro.ejecutar('rut-1', async s => s),
      registro.ejecutar('rut-1', async s => s),
    ]);

    expect(creadas).toBe(1);
    expect(a).toBe(b);
  });

  it('normaliza el RUT: mismo RUT en distinto formato resuelve la MISMA sesión', async () => {
    // Bug real: sin normalizar, "12.345.678-9" y "123456789" indexan claves
    // distintas y el registro crea una SEGUNDA sesión (segundo login) para la
    // misma persona —justo el escenario de sesiones simultáneas que el diseño
    // de RegistroSesiones existe para evitar.
    let creadas = 0;
    const registro = new RegistroSesiones((rut: string) => ({ rut, id: ++creadas }));

    const a = await registro.ejecutar('12.345.678-9', async s => s);
    const b = await registro.ejecutar('123456789', async s => s);

    expect(creadas).toBe(1);
    expect(a).toBe(b);
  });

  it('olvidar() descarta la sesión cacheada: la próxima llamada crea una nueva', async () => {
    let creadas = 0;
    const registro = new RegistroSesiones((rut: string) => ({ rut, id: ++creadas }));

    const a = await registro.ejecutar('rut-1', async s => s);
    registro.olvidar('rut-1');
    const b = await registro.ejecutar('rut-1', async s => s);

    expect(creadas).toBe(2);
    expect(a).not.toBe(b);
  });

  it('olvidar() normaliza el RUT igual que ejecutar()', async () => {
    let creadas = 0;
    const registro = new RegistroSesiones((rut: string) => ({ rut, id: ++creadas }));

    await registro.ejecutar('12.345.678-9', async s => s);
    registro.olvidar('123456789');
    await registro.ejecutar('12.345.678-9', async s => s);

    expect(creadas).toBe(2);
  });
});
