import {
  consultarSituacionTributaria,
  SituacionTributaria,
  TransporteSituacion,
} from '../scrapers/situacionTributaria';

// Consulta pública de situación tributaria de terceros. No usa el `ejecutor`
// de sesión (como los demás dominios) porque no hay clave ni sesión: es un par
// de POST HTTP planos. `transporte` se deja inyectable sólo para los tests.
export async function situacionTributaria(
  rut: string,
  transporte?: TransporteSituacion
): Promise<SituacionTributaria> {
  return consultarSituacionTributaria(rut, transporte);
}
