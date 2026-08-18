import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { clasificarErrorCredenciales } from './erroresSesion';

export type ResultadoValidacion =
  | { ok: true }
  | { ok: false; error: 'CREDENCIALES_INVALIDAS' | 'ERROR' };

// Valida una clave tributaria contra el SII real, de una sola pasada: autentica,
// confirma el resultado y cierra todo antes de devolver la respuesta — a
// diferencia de sii_iniciar_sesion, no deja nada operable.
//
// authenticateOnly() y logout() corren en el MISMO turno de la cola por RUT
// (dentro del mismo registro.ejecutar), con try/finally. Un logout() como una
// llamada a registro.ejecutar aparte quedaría encolado detrás de cualquier
// operación que haya entrado para ese RUT mientras tanto — ver la sección
// "Timeout" del spec.
export async function validarClave(
  rut: string,
  clave: string,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): Promise<ResultadoValidacion> {
  credenciales.guardar(rut, clave);
  try {
    await registro.ejecutar(rut, async sesion => {
      try {
        await sesion.authenticateOnly();
      } finally {
        await sesion.logout();
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: clasificarErrorCredenciales(e) };
  } finally {
    credenciales.borrar(rut);
  }
}
