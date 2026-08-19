import { compararApiKey } from '../src/apiKey';

describe('compararApiKey', () => {
  it('true cuando ambas coinciden', () => {
    expect(compararApiKey('clave-secreta', 'clave-secreta')).toBe(true);
  });

  it('false cuando difieren con la misma longitud', () => {
    expect(compararApiKey('clave-secretx', 'clave-secreta')).toBe(false);
  });

  it('false cuando difieren en longitud (no debe lanzar)', () => {
    expect(compararApiKey('corta', 'clave-mucho-mas-larga')).toBe(false);
  });

  it('false cuando la recibida está vacía', () => {
    expect(compararApiKey('', 'clave-secreta')).toBe(false);
  });
});
