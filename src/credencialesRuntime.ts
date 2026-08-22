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
    // Material de clave de terceros en /tmp compartido con path predecible:
    // writeFileSync con {mode} NO baja permisos si el archivo ya existe, por
    // eso se borra antes de escribir para garantizar 0o600 (solo el owner).
    fs.rmSync(certPath, { force: true });
    fs.writeFileSync(certPath, Buffer.from(certificadoBase64, 'base64'), { mode: 0o600 });
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
    try {
      fs.unlinkSync(rutaTemporalSii('pfxruntime', rut));
    } catch (e) {
      // ENOENT (no existía) es esperable y se ignora. Cualquier otro error
      // (EACCES/EBUSY) dejaría el .pfx en disco en silencio — se loguea sin
      // exponer el path para no filtrar el layout de /tmp.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('No se pudo borrar el .pfx temporal');
      }
    }
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
