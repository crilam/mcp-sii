import { RegistroSesiones, EjecutorSesion } from '../registroSesiones';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';

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
