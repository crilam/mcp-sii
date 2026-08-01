import { execFileSync } from 'child_process';
import * as fs from 'fs';

export interface CertValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Verifica que un .pfx/.p12 exista y que la contraseña dada lo desbloquee,
 * sin exponer el subject/issuer del certificado (pueden contener datos personales).
 */
export function validateCert(certPath: string, certPassword: string): CertValidationResult {
  if (!fs.existsSync(certPath)) {
    return { valid: false, error: `Archivo no encontrado: ${certPath}` };
  }

  try {
    // execFileSync evita interpolación de shell: la contraseña nunca pasa por un intérprete de comandos.
    execFileSync(
      'openssl',
      ['pkcs12', '-in', certPath, '-passin', `pass:${certPassword}`, '-noout', '-info'],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 }
    );
    return { valid: true };
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err
      ? (err as { stderr?: Buffer }).stderr?.toString().trim()
      : undefined;
    return { valid: false, error: stderr || 'No se pudo validar el certificado' };
  }
}

function main(): void {
  const certPath = process.env.SII_CERT_PATH;
  const certPassword = process.env.SII_CERT_PASSWORD;

  if (!certPath || !certPassword) {
    console.error('Configura SII_CERT_PATH y SII_CERT_PASSWORD en el entorno.');
    process.exit(1);
  }

  const result = validateCert(certPath, certPassword);
  if (result.valid) {
    console.log('✓ Certificado válido: la contraseña lo desbloquea correctamente.');
    process.exit(0);
  } else {
    console.error(`✗ Certificado inválido: ${result.error}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
