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
  // Clave del certificado que el contribuyente tiene cargado EN EL SII (el
  // "certificado centralizado"), con la que el SII firma los DTE del portal
  // mipyme del lado servidor.
  //
  // NO cae a `certPassword`, y es deliberado. Son dos cosas que se configuran
  // por separado y pueden diferir de dos maneras:
  //
  //   - el certificado cargado en el SII puede ser OTRO distinto del `.p12` de
  //     `SII_CERT_PATH`;
  //   - o puede ser EL MISMO archivo cargado con otra clave, que es el caso
  //     traicionero: comparar los certificados daría "coinciden" y la clave
  //     seguiría sin servir.
  //
  // O sea que no hay forma de derivar una de la otra, ni siquiera verificando.
  // Y adivinar acá tiene costo: mandaría la clave del certificado local a
  // `postFirmaDigital.cgi`, un endpoint que no tiene nada que ver con él, para
  // terminar fallando igual con un mensaje que apunta al lugar equivocado. Si
  // son el mismo certificado y la misma clave, se configuran las dos variables
  // con el mismo valor y queda explícito.
  //
  // Vive en el entorno y no en los parámetros de la tool a propósito: así el
  // modelo nunca la ve ni puede pedírsela al usuario en un chat.
  claveCertificadoSii?: string;
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
    claveCertificadoSii: process.env.SII_CERT_CLAVE_SII,
  };
}
