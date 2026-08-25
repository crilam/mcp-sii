import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { RutaHandler, badRequest } from './comun';

const zodValidarClave = z.object({ rut: z.string().min(1), clave: z.string().min(1) });

export type ResultadoValidacion =
  | { ok: true }
  | { ok: false; error: 'CREDENCIALES_INVALIDAS' | 'ERROR' };

// Valida una clave tributaria contra el SII real, de una sola pasada: autentica,
// confirma el resultado y cierra todo antes de devolver la respuesta — a
// diferencia de sii_iniciar_sesion, no deja nada operable.
//
// authenticateOnly() y logout() corren en el MISMO turno de la cola por RUT,
// con try/finally. Un logout() como una llamada a registro.ejecutar aparte
// quedaría encolado detrás de cualquier operación que haya entrado para ese
// RUT mientras tanto — ver la sección "Timeout" del spec.
//
// logout() va en su propio try/catch que descarta el error: si lanzara sin
// atajarlo, la semántica de `finally` en JS pisaría el resultado de
// authenticateOnly() — una clave CORRECTA terminaría reportada como ERROR
// sólo porque el logout posterior falló (red, sesión ya cerrada, etc). El
// propósito de este endpoint es clasificar la clave, no el logout.
//
// guardar/crear-sesión/authenticateOnly+logout/borrar corren TODOS dentro de
// registro.ejecutarPassThrough, como una sola unidad atómica encolada por
// RUT — no como guardar()-luego-ejecutar()-luego-borrar() sueltos. Dos
// llamadas concurrentes a este endpoint para el MISMO rut con clave DISTINTA
// (dos tenants consultando el mismo RUT, o un reintento) podían pisarse la
// credencial entre sí con los pasos sueltos: la primera terminaba
// autenticando con la clave de la segunda, y el borrar() de la que termina
// primero podía borrarle la credencial a la que todavía esperaba turno.
export async function validarClave(
  rut: string,
  clave: string,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): Promise<ResultadoValidacion> {
  try {
    await registro.ejecutarPassThrough(
      rut,
      () => credenciales.guardar(rut, clave),
      () => credenciales.borrar(rut),
      async sesion => {
        try {
          await sesion.authenticateOnly();
        } finally {
          try {
            await sesion.logout();
          } catch {
            // No contamina el resultado de authenticateOnly (ver comentario arriba).
          }
        }
      }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: clasificarErrorCredenciales(e) };
  }
}

export function registrarRutasSesion(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/sesion/validar-clave', async body => {
    const parseo = zodValidarClave.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, clave } = parseo.data;
    const resultado = await validarClave(rut, clave, registro, credenciales);
    return { status: 200, body: resultado };
  });
}
