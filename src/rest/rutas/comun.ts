import { z } from 'zod';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { RecursoNoEncontrado } from '../../erroresConsulta';

// Fragmento zod compartido por las 5 rutas REST que reciben certificado
// digital. La regex valida el alfabeto base64 (incluyendo padding) ANTES de
// intentar decodificar: un base64 con basura no falla en Buffer.from (que lo
// decodifica "lo mejor que puede"), sino que escribe un .pfx corrupto y
// termina en un error tardío genérico del scraper. Rechazarlo acá devuelve
// BAD_REQUEST temprano sin gastar cupo de rate-limit del tenant.
export const zodCredencialCert = {
  certificado_base64: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'certificado_base64 inválido'),
  certificado_password: z.string().min(1),
};

export interface RespuestaRuta {
  status: number;
  body: unknown;
}

export type RutaHandler = (body: unknown) => Promise<RespuestaRuta>;

// Traduce cualquier resultado de negocio del core al contrato {ok}. Una ruta
// REST nunca debería ver SesionNoIniciada (cada request trae su propia
// `clave`, arma la sesión de cero) — si ocurriera, se trata como ERROR de
// infraestructura, no como el caso de negocio esperado que sí es en MCP.
//
// Si `resultado` es un array (varios core devuelven listas: BoletaBhe[],
// Empresa[]), NO se spreadea directo — `{ ok: true, ...[a, b] }` produce
// `{ ok: true, "0": a, "1": b }` en JSON, perdiendo la forma de lista. Se
// envuelve bajo `datos` en ese caso; los resultados que ya son objetos siguen
// spreadeándose flat, como venía haciendo cada ruta.
export async function ejecutar<R>(fn: () => Promise<R>): Promise<RespuestaRuta> {
  try {
    const resultado = await fn();
    const cuerpo = Array.isArray(resultado) ? { datos: resultado } : (resultado as object);
    return { status: 200, body: { ok: true, ...cuerpo } };
  } catch (e) {
    // NO_ENCONTRADO se resuelve acá y no dentro de clasificarErrorCredenciales:
    // ésta es la única ruta que lo necesita, y ensanchar esa función obligaba a
    // cada otro llamador (validar-clave, las tools MCP) a colapsar a mano un
    // código que nunca puede recibir. Uno se olvidaba y stringificaba el código
    // crudo.
    //
    // Importa distinguirlo: cuando el SII confirma que el dato no existe, el
    // fallo es permanente. Con el ERROR genérico, el tenant no puede separarlo
    // de una caída del portal y reintenta en loop lo que nunca va a funcionar.
    if (e instanceof RecursoNoEncontrado) {
      return { status: 200, body: { ok: false, error: 'NO_ENCONTRADO' } };
    }
    const error = clasificarErrorCredenciales(e);
    // Un error que no es rechazo de credenciales es un bug (del scraper, de
    // infraestructura) — sin este log, queda invisible detrás del status 200.
    if (error === 'ERROR') {
      console.error('Error no clasificado en ruta REST:', e instanceof Error ? e.message : e);
    }
    return { status: 200, body: { ok: false, error } };
  }
}
