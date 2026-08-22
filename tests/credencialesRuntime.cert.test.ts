import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';
import { AuthStrategy } from '../src/env';
import * as fs from 'fs';
import { rutaTemporalSii } from '../src/rutaTemporalSii';

it('guardarCertificado escribe el pfx y arma config Certificate', async () => {
  const prov = new ProveedorCredencialesRuntime();
  const b64 = Buffer.from('contenido-pfx-fake').toString('base64');
  prov.guardarCertificado('11111111-1', b64, 'pass', 'clavecert');
  const cfg = await prov.para('11111111-1');
  expect(cfg.strategy).toBe(AuthStrategy.Certificate);
  expect(cfg.certPassword).toBe('pass');
  expect(cfg.claveCertificadoSii).toBe('clavecert');
  expect(fs.readFileSync(cfg.certPath!, 'utf-8')).toBe('contenido-pfx-fake');
});

it('borrar limpia el pfx temporal', async () => {
  const prov = new ProveedorCredencialesRuntime();
  prov.guardarCertificado('22222222-2', Buffer.from('x').toString('base64'), 'p');
  const ruta = rutaTemporalSii('pfxruntime', '22222222-2');
  expect(fs.existsSync(ruta)).toBe(true);
  prov.borrar('22222222-2');
  expect(fs.existsSync(ruta)).toBe(false);
});
