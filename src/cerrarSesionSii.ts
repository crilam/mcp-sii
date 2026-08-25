import { SessionManager } from './session';

// Cierre COMPLETO de una sesión del SII. Lo usan el servidor y los scripts: es
// la única definición, porque cuando hubo dos (una acá y `cerrarContexto` suelto
// en la factory del registro) el servidor terminó haciendo media limpieza sin
// que nadie lo notara.
//
// El orden importa y los dos pasos van blindados por separado.
//
// `logout()` primero, porque es el que libera la sesión DEL LADO DEL SII: sin él
// la sesión queda viva hasta que expira, y como el SII limita las simultáneas
// por RUT, dos corridas seguidas del mismo script chocan entre sí — justo lo que
// estos scripts evitan usando una sola sesión para todo el barrido.
// `cerrarContexto()` sólo libera el proceso y el perfil locales, así que no
// alcanza: es la mitad de la limpieza, no la limpieza.
//
// Y cada paso en su propio try, porque si `logout()` falla (el SII no responde,
// se cortó la red) el perfil local y el cookie jar TIENEN que borrarse igual:
// son credenciales de sesión vivas en disco. La limpieza local no puede quedar
// condicionada a que el portal esté disponible.
//
// Nada de esto lanza: se llama desde un `finally`, y una excepción acá taparía
// el error real que se estaba propagando.
export async function cerrarSesionSii(sesion: SessionManager): Promise<void> {
  try {
    await sesion.logout();
  } catch (e) {
    console.error(`(logout falló, la sesión del SII expirará sola: ${(e as Error).message})`);
  }
  try {
    sesion.cerrarContexto();
  } catch (e) {
    console.error(`(no se pudo cerrar el contexto local: ${(e as Error).message})`);
  }
}
