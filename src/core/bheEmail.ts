import { createHash } from 'crypto';
import { BheEmailScraper, EnvioPrevisualizado, BheEnviada } from '../scrapers/bheEmail';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';
import { VentanaIdempotencia, claveEstable } from '../idempotenciaEscritura';

export type { EnvioPrevisualizado, BheEnviada } from '../scrapers/bheEmail';

// Red anti-doble-click del reenvío por email: un doble-click no rompe nada
// tributario, pero duplica correos al receptor. Misma clase de la ronda 11.
export const ventanaEmail = new VentanaIdempotencia();

export async function enviarBheEmail(
  registro: EjecutorSesion<SessionManager>,
  rut: string,
  codigoBarras: string,
  email: string | undefined,
  confirmar: boolean
): Promise<EnvioPrevisualizado | BheEnviada> {
  const correr = () => registro.ejecutar(rut, async sesion =>
    new BheEmailScraper(new SiiHttpClient(sesion), sesion).enviar(codigoBarras, email, confirmar));
  if (!confirmar) return correr();
  const rutNormal = rut.replace(/\./g, '').toUpperCase();
  const clave = createHash('sha256').update(claveEstable([rutNormal, 'email', codigoBarras, email ?? ''])).digest('hex');
  return ventanaEmail.ejecutar(clave,
    'Este mismo envío ya está en curso o salió hace segundos. No se repite para no duplicar el correo.',
    correr);
}
