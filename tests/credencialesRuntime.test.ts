import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';
import { AuthStrategy } from '../src/env';

describe('ProveedorCredencialesRuntime', () => {
  it('guarda y devuelve la config de un RUT', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    proveedor.guardar('11.111.111-1', 'clave-secreta');
    const config = await proveedor.para('11.111.111-1');
    expect(config.rut).toBe('11.111.111-1');
    expect(config.clave).toBe('clave-secreta');
    expect(config.strategy).toBe(AuthStrategy.Clave);
  });

  it('normaliza el RUT: distintos formatos resuelven la misma entrada', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    proveedor.guardar('11.111.111-1', 'clave-secreta');
    const config = await proveedor.para('111111111');
    expect(config.clave).toBe('clave-secreta');
  });

  it('para() de un RUT no guardado lanza', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    await expect(proveedor.para('22.222.222-2')).rejects.toThrow();
  });

  it('borrar() elimina la entrada: para() posterior lanza', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    proveedor.guardar('11.111.111-1', 'clave-secreta');
    proveedor.borrar('11.111.111-1');
    await expect(proveedor.para('11.111.111-1')).rejects.toThrow();
  });

  it('borrar() de un RUT no guardado no lanza', () => {
    const proveedor = new ProveedorCredencialesRuntime();
    expect(() => proveedor.borrar('99.999.999-9')).not.toThrow();
  });
});
