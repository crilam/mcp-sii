// Redacción de secretos para mensajes que pueden terminar en un log o en el
// `detalle` de una respuesta REST. Nace de `resumenSeguro` en
// `boletas/auth.ts` (necesitaba blindar resúmenes de las respuestas de
// Cognito/SII contra el token OpenID o las credenciales AWS temporales) y se
// extrae a su propio módulo porque un segundo consumidor genérico —el
// catch-all de errores no clasificados en `rest/rutas/comun.ts`— necesita lo
// mismo sin importar del dominio de boletas para conseguirlo.
//
// Nombres de campo que, si aparecen, pueden traer un secreto: la clave
// tributaria, un password de certificado, o material de las credenciales
// temporales de AWS que arma el flujo de boletas.
export const CLAVES_SENSIBLES = /^(token|secretkey|sessiontoken|accesskeyid|password|clave)$/i;

// Resume un valor arbitrario (por ejemplo una respuesta parcial de una API) a
// JSON sin filtrar secretos: los campos cuyo NOMBRE matchea CLAVES_SENSIBLES
// se reemplazan por `[REDACTADO]` antes de serializar. Sólo mira nombres de
// campo, no el contenido de otros valores — para un secreto embebido dentro
// de un string bajo un nombre de campo cualquiera, ver `mensajeSeguro`.
export function resumenSeguro(valor: unknown): string {
  const redactado = JSON.stringify(valor, (clave, v) =>
    CLAVES_SENSIBLES.test(clave) ? '[REDACTADO]' : v
  );
  return (redactado ?? String(valor)).slice(0, 150);
}

// Mensaje de una excepción que ESTE módulo no controla — un catch-all no
// puede garantizar que quien lanzó el error evitó meter un secreto adentro
// (una `clave` en el argv de un subproceso, un query string con la
// contraseña). Se redactan los patrones `campo=valor` / `campo: valor` cuyo
// NOMBRE matchea CLAVES_SENSIBLES, y se trunca: un mensaje larguísimo (un dump
// de HTML, un stack) no aporta nada a quien integra y sí infla el log.
//
// Best-effort, no una garantía: un secreto que viaje sin ir precedido de un
// nombre reconocible (por ejemplo, pegado directo sin "clave=") no se detecta
// acá. La defensa de fondo sigue siendo la de siempre en este repo — construir
// cada Error para que su mensaje nunca lleve el secreto (ver ErrorDeBrowser en
// browser.ts) — y esto es la segunda capa para lo que se escape sin pasar por
// ahí.
export function mensajeSeguro(e: unknown): string {
  const mensaje = e instanceof Error ? e.message : String(e);
  const redactado = mensaje.replace(
    /\b(token|secretkey|sessiontoken|accesskeyid|password|clave)\s*[:=]\s*\S+/gi,
    (_m, campo: string) => `${campo}=[REDACTADO]`
  );
  return redactado.length > 300 ? `${redactado.slice(0, 300)}…` : redactado;
}
