import { validateEnv, getConfig, AuthStrategy } from '../src/env';

describe('validateEnv', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, orig);
    delete process.env.SII_RUT;
    delete process.env.SII_CLAVE;
    delete process.env.SII_CERT_PATH;
    delete process.env.SII_CERT_PASSWORD;
  });
  afterEach(() => { Object.assign(process.env, orig); });

  it('lanza error si falta SII_RUT', () => {
    delete process.env.SII_RUT;
    expect(() => validateEnv()).toThrow('SII_RUT');
  });

  it('lanza error si no hay SII_CLAVE ni SII_CERT_PATH', () => {
    process.env.SII_RUT = '12345678';
    expect(() => validateEnv()).toThrow('SII_CLAVE o SII_CERT_PATH');
  });

  it('lanza error si SII_CERT_PATH sin SII_CERT_PASSWORD', () => {
    process.env.SII_RUT = '12345678';
    process.env.SII_CERT_PATH = '/ruta/cert.pfx';
    expect(() => validateEnv()).toThrow('SII_CERT_PASSWORD');
  });

  it('no lanza error con RUT + clave', () => {
    process.env.SII_RUT = '12345678';
    process.env.SII_CLAVE = 'pass';
    expect(() => validateEnv()).not.toThrow();
  });

  it('no lanza error con RUT + certificado completo', () => {
    process.env.SII_RUT = '12345678';
    process.env.SII_CERT_PATH = '/ruta/cert.pfx';
    process.env.SII_CERT_PASSWORD = 'certpass';
    expect(() => validateEnv()).not.toThrow();
  });
});

describe('getConfig', () => {
  const orig = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, orig);
    delete process.env.SII_RUT;
    delete process.env.SII_CLAVE;
    delete process.env.SII_CERT_PATH;
    delete process.env.SII_CERT_PASSWORD;
  });
  afterEach(() => { Object.assign(process.env, orig); });

  it('retorna estrategia cert cuando hay SII_CERT_PATH', () => {
    process.env.SII_RUT = '12345678';
    process.env.SII_CERT_PATH = '/ruta/cert.pfx';
    process.env.SII_CERT_PASSWORD = 'certpass';
    const config = getConfig();
    expect(config.strategy).toBe(AuthStrategy.Certificate);
  });

  it('retorna estrategia clave cuando solo hay SII_CLAVE', () => {
    process.env.SII_RUT = '12345678';
    process.env.SII_CLAVE = 'pass';
    const config = getConfig();
    expect(config.strategy).toBe(AuthStrategy.Clave);
  });

  it('cert tiene precedencia sobre clave cuando ambos están', () => {
    process.env.SII_RUT = '12345678';
    process.env.SII_CLAVE = 'pass';
    process.env.SII_CERT_PATH = '/ruta/cert.pfx';
    process.env.SII_CERT_PASSWORD = 'certpass';
    const config = getConfig();
    expect(config.strategy).toBe(AuthStrategy.Certificate);
  });

  // La clave del certificado CARGADO EN EL SII no se deriva de la del .p12
  // local. Pueden ser certificados distintos, o el mismo archivo cargado con
  // otra clave —y en ese caso comparar los certificados diría "coinciden"
  // mientras la clave sigue sin servir—. Derivarla mandaría la clave del
  // certificado local a postFirmaDigital.cgi, que no tiene nada que ver con él.
  it('no deriva la clave del certificado del SII de SII_CERT_PASSWORD', () => {
    process.env.SII_RUT = '12345678';
    process.env.SII_CERT_PATH = '/ruta/cert.pfx';
    process.env.SII_CERT_PASSWORD = 'clave-del-p12-local';
    delete process.env.SII_CERT_CLAVE_SII;

    expect(getConfig().claveCertificadoSii).toBeUndefined();
  });

  it('toma la clave del certificado del SII sólo de SII_CERT_CLAVE_SII', () => {
    process.env.SII_RUT = '12345678';
    process.env.SII_CERT_PATH = '/ruta/cert.pfx';
    process.env.SII_CERT_PASSWORD = 'clave-del-p12-local';
    process.env.SII_CERT_CLAVE_SII = 'clave-del-cert-en-el-sii';

    expect(getConfig().claveCertificadoSii).toBe('clave-del-cert-en-el-sii');
  });
});
