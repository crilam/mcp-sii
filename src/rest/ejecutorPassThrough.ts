import { RegistroSesiones, EjecutorSesion } from '../registroSesiones';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';
import { Credencial } from './rutas/comun';

// Arma un EjecutorSesion de un solo uso para UN request REST: guardar la
// credencial, crear la sesión, correr fn y borrar la credencial corren como
// una sola unidad atómica encolada por RUT (ver
// RegistroSesiones.ejecutarPassThrough, PR #33). Sin esto, dos requests
// concurrentes al mismo RUT con clave DISTINTA podían pisarse la credencial
// entre sí. La misma función la usa cada dominio del adaptador REST — se
// extrae acá en vez de dejarla copiada 6 veces (una por dominio).
export function ejecutorPassThroughDe<T>(
  registro: RegistroSesiones<T>,
  credenciales: ProveedorCredencialesRuntime,
  rut: string,
  clave: string
): EjecutorSesion<T> {
  return {
    ejecutar: (rutInterno, fn) =>
      registro.ejecutarPassThrough(
        rutInterno,
        () => credenciales.guardar(rut, clave),
        () => credenciales.borrar(rut),
        fn
      ),
  };
}

// Elige el ejecutor según la credencial que trajo el request, sin que cada ruta
// tenga que repetir el `if`. Recibe la credencial ya discriminada (ver
// `credencialDe` en rutas/comun.ts), así que un tipo nuevo de credencial rompe
// la compilación acá en vez de caer en un `else` silencioso.
export function ejecutorPara<T>(
  registro: RegistroSesiones<T>,
  credenciales: ProveedorCredencialesRuntime,
  rut: string,
  credencial: Credencial
): EjecutorSesion<T> {
  return credencial.tipo === 'clave'
    ? ejecutorPassThroughDe(registro, credenciales, rut, credencial.clave)
    : ejecutorPassThroughCertDe(registro, credenciales, rut, credencial.base64, credencial.password);
}

// Arma un EjecutorSesion de un solo uso para UN request REST con autenticación
// por certificado digital: guardar el certificado, crear la sesión, correr fn
// y borrar el certificado corren como una sola unidad atómica encolada por RUT.
// Similar a ejecutorPassThroughDe pero para flujos de certificado.
export function ejecutorPassThroughCertDe<T>(
  registro: RegistroSesiones<T>,
  credenciales: ProveedorCredencialesRuntime,
  rut: string,
  certificadoBase64: string,
  certificadoPassword: string,
  claveCertSii?: string
): EjecutorSesion<T> {
  return {
    ejecutar: (rutInterno, fn) =>
      registro.ejecutarPassThrough(
        rutInterno,
        () => credenciales.guardarCertificado(rut, certificadoBase64, certificadoPassword, claveCertSii),
        () => credenciales.borrar(rut),
        fn
      ),
  };
}
