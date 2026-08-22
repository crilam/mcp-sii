import { RecursoNoEncontrado } from './erroresConsulta';

export class SesionNoIniciada extends Error {}
export class SesionExpirada extends Error {}

const MARCA_SIN_SESION = 'Llamá sii_iniciar_sesion primero';

export async function conErroresDeSesion<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && e.message.includes(MARCA_SIN_SESION)) {
      throw new SesionNoIniciada(e.message);
    }
    throw e;
  }
}

// Distingue "el SII rechazó la clave/RUT" de cualquier otro fallo (timeout, red,
// browser caído). Mismo criterio que ya usaba sii_iniciar_sesion inline; se
// extrae acá porque el endpoint de validación de clave necesita la misma
// clasificación y una segunda copia inline sería la misma duplicación que ya
// se resolvió una vez para conScraper.
export function clasificarErrorCredenciales(
  e: unknown
): 'CREDENCIALES_INVALIDAS' | 'NO_ENCONTRADO' | 'ERROR' {
  // NO_ENCONTRADO antes que nada: es el único caso donde el SII confirmó que el
  // dato no existe. Sin un código propio, un identificador equivocado
  // (permanente) devuelve exactamente los mismos bytes que una caída del portal
  // (transitoria), y el tenant no tiene con qué decidir si reintentar.
  if (e instanceof RecursoNoEncontrado) return 'NO_ENCONTRADO';
  const mensaje = e instanceof Error ? e.message : String(e);
  return mensaje.includes('El SII rechazó la autenticación') ? 'CREDENCIALES_INVALIDAS' : 'ERROR';
}

// Envuelve el resultado de una función de core (src/core/*.ts) en el contrato
// {content} que exige el SDK de MCP, traduciendo SesionNoIniciada a
// {ok:false, error:'SESION_NO_INICIADA'} en vez de dejarla escapar. Extraído
// de tools/rcv.ts (PR #33) porque un segundo dominio ya la necesita — misma
// razón por la que se extrajo clasificarErrorCredenciales.
export async function envolverParaMcp<R>(fn: () => Promise<R>): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const resultado = await conErroresDeSesion(fn).catch(e => {
    if (e instanceof SesionNoIniciada) return { __error: 'SESION_NO_INICIADA' as const };
    throw e;
  });
  if (resultado && typeof resultado === 'object' && '__error' in resultado) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: resultado.__error }) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }] };
}
