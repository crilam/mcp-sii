import { ejecutorPassThroughDe } from '../../src/rest/ejecutorPassThrough';
import { RegistroSesiones } from '../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../src/credencialesRuntime';

describe('ejecutorPassThroughDe', () => {
  it('guarda la credencial, corre fn, y la borra — vía ejecutarPassThrough del registro', async () => {
    const llamadas: any[] = [];
    const registro = {
      ejecutarPassThrough: (rut: string, preparar: () => void, finalizar: () => void, fn: any) => {
        llamadas.push({ rut, preparar, finalizar });
        return Promise.resolve('fn').then(async () => { preparar(); const r = await fn({}); finalizar(); return r; });
      },
    } as unknown as RegistroSesiones<any>;
    const credenciales = new ProveedorCredencialesRuntime();

    const ejecutor = ejecutorPassThroughDe(registro, credenciales, '11.111.111-1', 'secreta');
    const resultado = await ejecutor.ejecutar('11.111.111-1', async () => 'ok');

    expect(resultado).toBe('ok');
    expect(llamadas).toHaveLength(1);
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow(); // borrada al final
  });
});
