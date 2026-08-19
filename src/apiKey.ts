import { timingSafeEqual } from 'crypto';

// Compara en tiempo constante para no filtrar por timing cuánto prefijo de la
// API key coincide. crypto.timingSafeEqual lanza si los buffers tienen
// longitud distinta, así que ese caso se resuelve aparte — pero igual se hace
// una comparación de la misma duración (contra sí misma) para no introducir
// un camino más rápido cuando la longitud no calza.
export function compararApiKey(recibida: string, esperada: string): boolean {
  const bufRecibida = Buffer.from(recibida);
  const bufEsperada = Buffer.from(esperada);

  if (bufRecibida.length !== bufEsperada.length) {
    timingSafeEqual(bufEsperada, bufEsperada);
    return false;
  }

  return timingSafeEqual(bufRecibida, bufEsperada);
}
