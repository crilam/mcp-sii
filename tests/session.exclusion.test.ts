import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

const config: SiiConfig = {
  rut: '11111111-1',
  strategy: AuthStrategy.Clave,
  clave: 'mipass',
};

function nuevoManager(): SessionManager {
  return new SessionManager(config, new MockBrowser());
}

// El bug que este test protege: la sesión del SII tiene UNA empresa activa, así
// que dos llamadas con empresas distintas que se intercalen (A selecciona, B
// selecciona, A lee) hacen que A lea la página de B y devuelva datos de otro
// contribuyente como si fueran correctos. Lo que se verifica no es el resultado
// sino el ORDEN observable: cada operación tiene que completar seleccionar+leer
// antes de que la otra empiece.
describe('SessionManager.conEmpresaExclusiva', () => {
  // Simula el ciclo real: seleccionar empresa, ceder el control al event loop
  // (donde antes se colaba la otra llamada) y recién ahí leer la página.
  function operacion(mgr: SessionManager, empresa: string, orden: string[]): Promise<void> {
    return mgr.conEmpresaExclusiva(async () => {
      orden.push(`seleccionar-${empresa}`);
      await new Promise(resolve => setTimeout(resolve, 0));
      orden.push(`leer-${empresa}`);
    });
  }

  it('no intercala dos operaciones concurrentes con empresas distintas', async () => {
    const mgr = nuevoManager();
    const orden: string[] = [];

    await Promise.all([
      operacion(mgr, 'A', orden),
      operacion(mgr, 'B', orden),
    ]);

    expect(orden).toEqual(['seleccionar-A', 'leer-A', 'seleccionar-B', 'leer-B']);
  });

  it('libera el candado cuando la operación falla', async () => {
    const mgr = nuevoManager();
    const orden: string[] = [];

    const fallida = mgr.conEmpresaExclusiva(async () => {
      orden.push('seleccionar-A');
      throw new Error('la sesión expiró');
    });

    // La segunda se encola mientras la primera todavía no falló: si el error
    // dejara el candado tomado, este await nunca resolvería.
    const siguiente = operacion(mgr, 'B', orden);

    await expect(fallida).rejects.toThrow('la sesión expiró');
    await siguiente;

    expect(orden).toEqual(['seleccionar-A', 'seleccionar-B', 'leer-B']);
  });

  it('permite reentrar sin deadlock cuando una operación serializada llama a otra', async () => {
    const mgr = nuevoManager();
    const orden: string[] = [];

    await mgr.conEmpresaExclusiva(async () => {
      orden.push('externa');
      await mgr.conEmpresaExclusiva(async () => { orden.push('interna'); });
    });

    expect(orden).toEqual(['externa', 'interna']);
  });

  it('devuelve el valor de la operación', async () => {
    const mgr = nuevoManager();

    await expect(mgr.conEmpresaExclusiva(async () => 42)).resolves.toBe(42);
  });
});
