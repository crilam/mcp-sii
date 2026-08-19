import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';

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

// Fábrica de `conScraper`: cada tool file la llama una vez con cómo armar su
// scraper a partir de una sesión, y obtiene un helper que abre sesión del RUT,
// corre `fn` contra el scraper, y traduce SesionNoIniciada al contrato
// {ok:false, error} en vez de dejarla escapar como excepción. Antes esta misma
// lógica de wrap estaba copiada en cada tool file (bhe/dte/rcv/renta/mipyme) y
// una sexta vez, inline, en bienesRaices.
// Distingue "el SII rechazó la clave/RUT" de cualquier otro fallo (timeout, red,
// browser caído). Mismo criterio que ya usaba sii_iniciar_sesion inline; se
// extrae acá porque el endpoint de validación de clave necesita la misma
// clasificación y una segunda copia inline sería la misma duplicación que ya
// se resolvió una vez para conScraper.
export function clasificarErrorCredenciales(e: unknown): 'CREDENCIALES_INVALIDAS' | 'ERROR' {
  const mensaje = e instanceof Error ? e.message : String(e);
  return mensaje.includes('El SII rechazó la autenticación') ? 'CREDENCIALES_INVALIDAS' : 'ERROR';
}

export function crearConScraper<S>(crearScraper: (sesion: SessionManager) => S) {
  return async function conScraper<R>(
    registro: RegistroSesiones<SessionManager>,
    rut: string,
    fn: (scraper: S) => Promise<R>
  ): Promise<{ content: [{ type: 'text'; text: string }] }> {
    const resultado = await conErroresDeSesion(() =>
      registro.ejecutar(rut, async sesion => fn(crearScraper(sesion)))
    ).catch(e => {
      if (e instanceof SesionNoIniciada) {
        return { __error: 'SESION_NO_INICIADA' as const };
      }
      throw e;
    });

    if (resultado && typeof resultado === 'object' && '__error' in resultado) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: resultado.__error }) }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(resultado, null, 2) }],
    };
  };
}
