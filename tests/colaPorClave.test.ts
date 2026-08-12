import { ColaPorClave } from '../src/colaPorClave';

// Registra el orden real de entrada/salida de cada operación, para poder
// afirmar si dos se solaparon o corrieron en serie.
function traza() {
  const eventos: string[] = [];
  const op = (nombre: string, ms: number) => async () => {
    eventos.push(`${nombre}:in`);
    await new Promise(r => setTimeout(r, ms));
    eventos.push(`${nombre}:out`);
    return nombre;
  };
  return { eventos, op };
}

describe('ColaPorClave', () => {
  it('serializa dos operaciones de la MISMA clave: la segunda espera a la primera', async () => {
    const cola = new ColaPorClave();
    const { eventos, op } = traza();

    // A tarda más que B. Si se solaparan, B entraría antes de que A salga.
    await Promise.all([
      cola.ejecutar('rut-1', op('A', 30)),
      cola.ejecutar('rut-1', op('B', 1)),
    ]);

    // Serializado: A entra, A sale, B entra, B sale. Nunca A:in, B:in juntos.
    expect(eventos).toEqual(['A:in', 'A:out', 'B:in', 'B:out']);
  });

  it('corre en paralelo dos operaciones de claves DISTINTAS', async () => {
    const cola = new ColaPorClave();
    const { eventos, op } = traza();

    // Si se serializaran, A saldría antes de que B entre. En paralelo, las dos
    // entran antes de que cualquiera salga.
    await Promise.all([
      cola.ejecutar('rut-1', op('A', 20)),
      cola.ejecutar('rut-2', op('B', 20)),
    ]);

    expect(eventos.slice(0, 2).sort()).toEqual(['A:in', 'B:in']);
  });

  it('propaga el error al llamador y devuelve el valor de la operación', async () => {
    const cola = new ColaPorClave();

    await expect(
      cola.ejecutar('rut-1', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    await expect(cola.ejecutar('rut-1', async () => 42)).resolves.toBe(42);
  });

  it('un error en una operación no deja trabada la cola de esa clave', async () => {
    const cola = new ColaPorClave();
    const { eventos, op } = traza();

    // La primera falla; la segunda de la MISMA clave tiene que correr igual.
    // Sin el finally/catch, la cadena quedaría en una promesa rechazada y la
    // segunda esperaría para siempre.
    const fallo = cola.ejecutar('rut-1', async () => { throw new Error('x'); });
    const sigue = cola.ejecutar('rut-1', op('B', 1));

    await expect(fallo).rejects.toThrow('x');
    await expect(sigue).resolves.toBe('B');
    expect(eventos).toEqual(['B:in', 'B:out']);
  });
});
