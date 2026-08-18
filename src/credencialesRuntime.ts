import { AuthStrategy, SiiConfig } from './env';
import { ProveedorCredenciales } from './credenciales';

function normalizar(rut: string): string {
  return rut.replace(/[^0-9kK]/g, '').toUpperCase();
}

// Credenciales que llegan en tiempo de ejecución vía sii_iniciar_sesion, no de
// env. Vive sólo en memoria del proceso: nunca se persiste a disco. A
// diferencia de CredencialesEnMemoria (que se arma una sola vez al boot desde
// env), este proveedor tiene métodos de escritura porque la tool lo alimenta
// mientras el servidor corre.
export class ProveedorCredencialesRuntime implements ProveedorCredenciales {
  private porRut = new Map<string, SiiConfig>();

  guardar(rut: string, clave: string): void {
    this.porRut.set(normalizar(rut), {
      rut,
      clave,
      strategy: AuthStrategy.Clave,
    });
  }

  borrar(rut: string): void {
    this.porRut.delete(normalizar(rut));
  }

  async para(rut: string): Promise<SiiConfig> {
    const config = this.porRut.get(normalizar(rut));
    if (!config) {
      throw new Error(`No hay sesión iniciada para el RUT ${rut}. Llamá sii_iniciar_sesion primero.`);
    }
    return config;
  }
}
