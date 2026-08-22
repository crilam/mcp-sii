import * as fs from 'fs';
import { AuthStrategy, SiiConfig } from './env';
import { ProveedorCredenciales, normalizar } from './credenciales';
import { rutaTemporalSii } from './rutaTemporalSii';

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

  guardarCertificado(rut: string, certificadoBase64: string, certificadoPassword: string, claveCertSii?: string): void {
    const certPath = rutaTemporalSii('pfxruntime', rut);
    fs.writeFileSync(certPath, Buffer.from(certificadoBase64, 'base64'));
    this.porRut.set(normalizar(rut), {
      rut,
      strategy: AuthStrategy.Certificate,
      certPath,
      certPassword: certificadoPassword,
      claveCertificadoSii: claveCertSii,
    });
  }

  borrar(rut: string): void {
    const n = normalizar(rut);
    try { fs.unlinkSync(rutaTemporalSii('pfxruntime', rut)); } catch { /* no existía */ }
    this.porRut.delete(n);
  }

  async para(rut: string): Promise<SiiConfig> {
    const config = this.porRut.get(normalizar(rut));
    if (!config) {
      throw new Error(`No hay sesión iniciada para el RUT ${rut}. Llamá sii_iniciar_sesion primero.`);
    }
    return config;
  }
}
