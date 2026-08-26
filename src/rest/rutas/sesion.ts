import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { SesionesSimultaneas, LimiteDeConsultasSii } from '../../erroresConsulta';
import { RutaHandler, badRequest } from './comun';

const zodValidarClave = z.object({ rut: z.string().min(1), clave: z.string().min(1) });

export type ResultadoValidacion =
  | { ok: true }
  | { ok: false; error: 'CREDENCIALES_INVALIDAS' | 'SESIONES_SIMULTANEAS' | 'LIMITE_SII' | 'ERROR' };

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
    // El bloqueo por sesiones simultáneas se distingue ANTES de clasificar, y en
    // esta ruta importa más que en ninguna: es la que Tributy llama
    // sincrónicamente para decidir si GUARDA una clave. Con el ERROR genérico,
    // un bloqueo del SII se lee como "no pudimos validar, la clave es dudosa"
    // cuando la clave puede estar perfecta y el problema es que hay otra consulta
    // en curso sobre el mismo RUT.
    //
    // `clasificarErrorCredenciales` no puede resolverlo: sólo devuelve
    // CREDENCIALES_INVALIDAS o ERROR, y ensancharla obligaría a cada otro
    // llamador —las tools MCP— a manejar un código que no le corresponde.
    if (e instanceof SesionesSimultaneas) {
      return { ok: false, error: 'SESIONES_SIMULTANEAS' };
    }
    // Y el corte por volumen del SII, por el mismo motivo: con el ERROR genérico
    // el tenant no distingue "no pudimos validar" de "el SII nos está cortando",
    // y en el segundo caso reintentar de inmediato empeora el corte. Faltaba
    // justo en la ruta donde la distinción más importa.
    if (e instanceof LimiteDeConsultasSii) {
      return { ok: false, error: 'LIMITE_SII' };
    }
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
