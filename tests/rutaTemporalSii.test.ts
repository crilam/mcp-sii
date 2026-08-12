import * as os from 'os';
import { rutaTemporalSii } from '../src/rutaTemporalSii';

describe('rutaTemporalSii', () => {
  it('da rutas distintas para RUTs distintos: dos credenciales no comparten archivo', () => {
    // El cookie jar es estado vivo de la sesión. Si dos credenciales apuntaran
    // al mismo archivo, la segunda pisaría las cookies de la primera y las
    // consultas saldrían con la sesión equivocada, sin ningún error.
    const a = rutaTemporalSii('cookies', '11111111-1');
    const b = rutaTemporalSii('cookies', '22222222-2');

    expect(a).not.toBe(b);
  });

  it('da la misma ruta para el mismo RUT y el mismo nombre: la sesión persiste entre llamadas', () => {
    expect(rutaTemporalSii('cookies', '11111111-1')).toBe(rutaTemporalSii('cookies', '11111111-1'));
  });

  it('separa archivos distintos del mismo RUT (jar, cert, key no colisionan)', () => {
    const jar = rutaTemporalSii('cookies', '11111111-1');
    const cert = rutaTemporalSii('cert', '11111111-1');
    const key = rutaTemporalSii('key', '11111111-1');

    expect(new Set([jar, cert, key]).size).toBe(3);
  });

  it('vive en el directorio temporal del sistema', () => {
    expect(rutaTemporalSii('cookies', '11111111-1').startsWith(os.tmpdir())).toBe(true);
  });

  it('no deja que un RUT con caracteres raros se escape del directorio temporal', () => {
    // Defensa: el RUT llega de configuración, pero un valor con "/" o ".."
    // podría apuntar el archivo fuera del tmp. El nombre resultante no debe
    // contener separadores de ruta.
    const ruta = rutaTemporalSii('cookies', '../../etc/passwd');
    const base = ruta.slice(os.tmpdir().length + 1);

    expect(base).not.toContain('/');
    expect(base).not.toContain('..');
  });
});
