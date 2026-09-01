import { VentanaIdempotencia, marcarSeguro, esSeguroDeLiberar, claveEstable } from '../src/idempotenciaEscritura';
import { LimitacionConocida } from '../src/erroresConsulta';

describe('marcarSeguro / esSeguroDeLiberar', () => {
  it('un error marcado se reconoce como seguro; uno sin marca, no', () => {
    expect(esSeguroDeLiberar(marcarSeguro(new Error('x')))).toBe(true);
    expect(esSeguroDeLiberar(new Error('x'))).toBe(false);
    expect(esSeguroDeLiberar(undefined)).toBe(false);
  });
});

describe('claveEstable', () => {
  it('el mismo objeto con las claves en otro orden da la misma serialización', () => {
    const a = { rut: '1', params: { retieneReceptor: true, fecha: 'x', lineas: [{ valor: 1, descripcion: 'd' }] } };
    const b = { params: { fecha: 'x', lineas: [{ descripcion: 'd', valor: 1 }], retieneReceptor: true }, rut: '1' };
    expect(claveEstable(a)).toBe(claveEstable(b));
  });
  it('objetos distintos dan claves distintas', () => {
    expect(claveEstable({ a: 1 })).not.toBe(claveEstable({ a: 2 }));
  });
  it('respeta el orden de los ARRAYS (no los ordena)', () => {
    expect(claveEstable([1, 2])).not.toBe(claveEstable([2, 1]));
  });
});

describe('VentanaIdempotencia', () => {
  it('bloquea una segunda ejecución con la misma clave', async () => {
    const v = new VentanaIdempotencia();
    await v.ejecutar('k', 'dup', async () => 1);
    await expect(v.ejecutar('k', 'dup', async () => 2)).rejects.toBeInstanceOf(LimitacionConocida);
  });

  it('claves distintas no se estorban', async () => {
    const v = new VentanaIdempotencia();
    await v.ejecutar('a', 'dup', async () => 1);
    await expect(v.ejecutar('b', 'dup', async () => 2)).resolves.toBe(2);
  });

  it('reserva SÍNCRONA: dos ejecuciones concurrentes corren una sola vez', async () => {
    const v = new VentanaIdempotencia();
    let resolver: (n: number) => void;
    const fn = jest.fn(() => new Promise<number>(r => { resolver = r; }));
    const a = v.ejecutar('k', 'dup', fn);
    const b = v.ejecutar('k', 'dup', fn);
    resolver!(1);
    const res = await Promise.allSettled([a, b]);
    expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('un fallo marcado seguro libera; uno sin marca mantiene', async () => {
    const v = new VentanaIdempotencia();
    // Sin marca: el fallo mantiene la reserva.
    await expect(v.ejecutar('m', 'dup', async () => { throw new Error('ambiguo'); })).rejects.toThrow('ambiguo');
    await expect(v.ejecutar('m', 'dup', async () => 1)).rejects.toBeInstanceOf(LimitacionConocida);
    // Marcado seguro: libera, el reintento entra.
    await expect(v.ejecutar('s', 'dup', async () => { throw marcarSeguro(new Error('seguro')); })).rejects.toThrow('seguro');
    await expect(v.ejecutar('s', 'dup', async () => 2)).resolves.toBe(2);
  });

  // EL bloqueante: una operación EN VUELO que tarda más que la ventana NO se
  // barre; un segundo request durante ese lapso se bloquea (es el doble-click
  // del usuario que reintenta porque la primera tardó).
  it('una operación en vuelo más larga que la ventana no se libera', async () => {
    const v = new VentanaIdempotencia(50);
    let resolver: (n: number) => void;
    const lenta = v.ejecutar('k', 'dup', () => new Promise<number>(r => { resolver = r; }));
    // La primera sigue en vuelo pasada la ventana.
    await new Promise(r => setTimeout(r, 80));
    await expect(v.ejecutar('k', 'dup', async () => 2)).rejects.toBeInstanceOf(LimitacionConocida);
    resolver!(1);
    await expect(lenta).resolves.toBe(1);
  });

  it('pasada la ventana, la misma clave vuelve a entrar', async () => {
    const v = new VentanaIdempotencia(50);
    await v.ejecutar('k', 'dup', async () => 1);
    await new Promise(r => setTimeout(r, 60));
    await expect(v.ejecutar('k', 'dup', async () => 2)).resolves.toBe(2);
  });
});
