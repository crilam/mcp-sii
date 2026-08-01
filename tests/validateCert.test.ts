import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateCert } from '../src/validateCert';

describe('validateCert', () => {
  let tmpDir: string;
  let certPath: string;
  const password = 'test-pass-123';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-cert-test-'));
    certPath = path.join(tmpDir, 'test.pfx');
    const keyPath = path.join(tmpDir, 'test.key');
    const crtPath = path.join(tmpDir, 'test.crt');

    // Genera un certificado autofirmado efímero, sin datos personales, solo para el test.
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', crtPath,
      '-days', '1', '-subj', '/CN=test',
    ]);
    execFileSync('openssl', [
      'pkcs12', '-export',
      '-inkey', keyPath, '-in', crtPath,
      '-out', certPath, '-passout', `pass:${password}`,
    ]);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retorna valid=true con la contraseña correcta', () => {
    const result = validateCert(certPath, password);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('retorna valid=false con contraseña incorrecta', () => {
    const result = validateCert(certPath, 'password-incorrecto');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('retorna valid=false si el archivo no existe', () => {
    const result = validateCert('/ruta/inexistente.pfx', password);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('no encontrado');
  });
});
