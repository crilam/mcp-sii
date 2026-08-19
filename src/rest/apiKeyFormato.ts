import { randomBytes, createHash } from 'crypto';

// Formato sk_<tenant>_<random>: el prefijo con el nombre del tenant ayuda a
// identificar de un vistazo de qué consumidor es una key en logs de acceso o
// paneles, sin exponer nada sensible (la key entera sigue siendo el secreto).
export function generarApiKey(nombreTenant: string): string {
  const random = randomBytes(32).toString('base64url');
  return `sk_${nombreTenant}_${random}`;
}

// Sólo el hash se guarda en Neon (api_keys.key_hash) — la key real se muestra
// una única vez al crearla y no se persiste en ningún lado.
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
