import { ejecutorPassThroughCertDe } from '../../src/rest/ejecutorPassThrough';
import { RegistroSesiones, EjecutorSesion } from '../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../src/credencialesRuntime';

describe('ejecutorPassThroughCertDe', () => {
  it('invoca guardarCertificado en preparar y borrar en finalizar', async () => {
    // Mock de credenciales con guardarCertificado y borrar como jest.fn()
    const credenciales = {
      guardarCertificado: jest.fn(),
      borrar: jest.fn(),
    } as any as ProveedorCredencialesRuntime;

    // Mock de registro con ejecutarPassThrough que invoca preparar/finalizar
    let prepararFueLlamado = false;
    let finalizarFueLlamado = false;

    const registro = {
      ejecutarPassThrough: jest.fn(
        async (rut: string, preparar: () => void, finalizar: () => void, fn: () => Promise<any>) => {
          preparar();
          prepararFueLlamado = true;
          try {
            return await fn();
          } finally {
            finalizar();
            finalizarFueLlamado = true;
          }
        }
      ),
    } as any as RegistroSesiones<any>;

    const rut = '12.345.678-9';
    const certificadoBase64 = 'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t'; // base64 simulado
    const certificadoPassword = 'mi-password';
    const claveCertSii = 'mi-clave-cert';

    // Crear el ejecutor
    const ejecutor: EjecutorSesion<any> = ejecutorPassThroughCertDe(
      registro,
      credenciales,
      rut,
      certificadoBase64,
      certificadoPassword,
      claveCertSii
    );

    // Ejecutar la función que devuelve el ejecutor
    await ejecutor.ejecutar('12345678', async () => 'resultado');

    // Verificar que preparar invocó guardarCertificado con los parámetros correctos
    expect(credenciales.guardarCertificado).toHaveBeenCalledWith(
      rut,
      certificadoBase64,
      certificadoPassword,
      claveCertSii
    );

    // Verificar que finalizar invocó borrar
    expect(credenciales.borrar).toHaveBeenCalledWith(rut);

    // Verificar que ambas fueron llamadas
    expect(prepararFueLlamado).toBe(true);
    expect(finalizarFueLlamado).toBe(true);
  });

  it('invoca guardarCertificado sin claveCertSii cuando es undefined', async () => {
    const credenciales = {
      guardarCertificado: jest.fn(),
      borrar: jest.fn(),
    } as any as ProveedorCredencialesRuntime;

    const registro = {
      ejecutarPassThrough: jest.fn(
        async (rut: string, preparar: () => void, finalizar: () => void, fn: () => Promise<any>) => {
          preparar();
          try {
            return await fn();
          } finally {
            finalizar();
          }
        }
      ),
    } as any as RegistroSesiones<any>;

    const rut = '12.345.678-9';
    const certificadoBase64 = 'LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t';
    const certificadoPassword = 'mi-password';

    const ejecutor: EjecutorSesion<any> = ejecutorPassThroughCertDe(
      registro,
      credenciales,
      rut,
      certificadoBase64,
      certificadoPassword
    );

    await ejecutor.ejecutar('12345678', async () => 'resultado');

    // Verificar que guardarCertificado fue llamado sin claveCertSii
    expect(credenciales.guardarCertificado).toHaveBeenCalledWith(
      rut,
      certificadoBase64,
      certificadoPassword,
      undefined
    );

    expect(credenciales.borrar).toHaveBeenCalledWith(rut);
  });
});
