export enum AuthStrategy {
  Clave = 'clave',
  Certificate = 'certificate',
}

export interface SiiConfig {
  rut: string;
  strategy: AuthStrategy;
  clave?: string;
  certPath?: string;
  certPassword?: string;
  empresaRut?: string;
}

export function validateEnv(): void {
  if (!process.env.SII_RUT) {
    throw new Error('Variable de entorno requerida no encontrada: SII_RUT');
  }
  const hasClave = !!process.env.SII_CLAVE;
  const hasCert = !!process.env.SII_CERT_PATH;
  if (!hasClave && !hasCert) {
    throw new Error('Configura SII_CLAVE o SII_CERT_PATH en las variables de entorno');
  }
  if (hasCert && !process.env.SII_CERT_PASSWORD) {
    throw new Error('SII_CERT_PATH requiere SII_CERT_PASSWORD');
  }
}

export function getConfig(): SiiConfig {
  const rut = process.env.SII_RUT!;
  const certPath = process.env.SII_CERT_PATH;
  const certPassword = process.env.SII_CERT_PASSWORD;
  const clave = process.env.SII_CLAVE;

  const strategy = certPath ? AuthStrategy.Certificate : AuthStrategy.Clave;

  return {
    rut,
    strategy,
    clave,
    certPath,
    certPassword,
    empresaRut: process.env.SII_EMPRESA_RUT,
  };
}
