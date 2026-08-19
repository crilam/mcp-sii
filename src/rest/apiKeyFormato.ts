import { randomBytes, createHash } from 'crypto';

// Formato sk_<tenant>_<random>: el prefijo con el nombre del tenant ayuda a
// identificar de un vistazo de qué consumidor es una key en logs de acceso o
// paneles, sin exponer nada sensible (la key entera sigue siendo el secreto).
// Precisamente porque el prefijo es legible, el header Authorization
// completo NUNCA debe llegar a un log — no sólo por el secreto en sí, sino
// porque el prefijo ya identifica de qué tenant es (ver el catch de
// manejarRequest en restServer.ts, que loguea sólo el mensaje del error).
export function generarApiKey(nombreTenant: string): string {
  const random = randomBytes(32).toString('base64url');
  return `sk_${nombreTenant}_${random}`;
}

// Sólo el hash se guarda en Neon (api_keys.key_hash) — la key real se muestra
// una única vez al crearla y no se persiste en ningún lado.
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
