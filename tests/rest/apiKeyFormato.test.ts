import { generarApiKey, hashApiKey } from '../../src/rest/apiKeyFormato';

describe('generarApiKey', () => {
  it('tiene el formato sk_<tenant>_<random>', () => {
    const key = generarApiKey('rdte');
    expect(key).toMatch(/^sk_rdte_[A-Za-z0-9_-]{40,}$/);
  });

  it('genera keys distintas en cada llamada', () => {
    expect(generarApiKey('rdte')).not.toBe(generarApiKey('rdte'));
  });
});

describe('hashApiKey', () => {
  it('es determinístico', () => {
    const key = generarApiKey('rdte');
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('no revierte la key original', () => {
    const key = generarApiKey('rdte');
    expect(hashApiKey(key)).not.toContain(key);
  });
});
