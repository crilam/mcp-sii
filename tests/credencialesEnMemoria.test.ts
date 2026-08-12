import { CredencialesEnMemoria } from '../src/credenciales';
import { AuthStrategy, SiiConfig } from '../src/env';

const configA: SiiConfig = {
  rut: '11111111-1',
  strategy: AuthStrategy.Certificate,
  certPath: '/certs/a.pfx',
  certPassword: 'clave-a',
};

describe('CredencialesEnMemoria', () => {
  it('devuelve la config de un RUT registrado', async () => {
    const prov = new CredencialesEnMemoria([configA]);

    await expect(prov.para('11111111-1')).resolves.toEqual(configA);
  });

  it('falla con un RUT no registrado, sin filtrar cuáles hay', async () => {
    // El error no debe enumerar los RUTs conocidos: son credenciales de
    // clientes, y la lista no tiene por qué exponerse a quien pidió una que no
    // existe.
    const prov = new CredencialesEnMemoria([configA]);

    await expect(prov.para('99999999-9')).rejects.toThrow(/99999999-9/);
    await expect(prov.para('99999999-9')).rejects.not.toThrow(/11111111-1/);
  });

  it('indexa por RUT normalizado: da igual con o sin puntos y guion', async () => {
    // El RUT llega de distintos consumidores con distinto formato. Buscar por el
    // literal exacto haría que "11.111.111-1" no encuentre la credencial de
    // "11111111-1", y el cliente parecería no estar dado de alta.
    const prov = new CredencialesEnMemoria([configA]);

    await expect(prov.para('11.111.111-1')).resolves.toEqual(configA);
    await expect(prov.para('111111111')).resolves.toEqual(configA);
  });
});
