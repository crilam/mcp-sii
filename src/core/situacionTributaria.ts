import {
  consultarSituacionTributaria,
  SituacionTributaria,
  TransporteSituacion,
} from '../scrapers/situacionTributaria';
import { partirRut } from '../rut';

// Consulta pública de situación tributaria de terceros. No usa el `ejecutor`
// de sesión (como los demás dominios) porque no hay clave ni sesión: es un par
// de POST HTTP planos. `transporte` se deja inyectable sólo para los tests.

// Caché en memoria por RUT. La situación tributaria de un contribuyente casi no
// cambia —el inicio de actividades, el giro, la condición de pro-pyme se mueven
// en meses, no en minutos—, y esta consulta le pega a `zeus.sii.cl` DOS veces
// por llamada (captcha + informe) sin ninguna credencial que la limite del lado
// del SII. Sin caché, un tenant repitiendo el mismo RUT martilla el portal ajeno
// hasta agotar su cuota de rate-limit; con TTL de un día, la primera consulta
// paga y el resto sale de memoria.
//
// En memoria y no en Neon a propósito: es un caché de cortesía, no un registro.
// Perderlo al reiniciar no rompe nada —se vuelve a consultar— y evita sumarle a
// esta ruta una dependencia de base de datos que hoy no tiene.
const TTL_MS = 24 * 60 * 60 * 1000;

// Techo de entradas para que el caché no sea una fuga de memoria: son ~200 bytes
// por RUT, así que 5000 son ~1 MB. Al llenarse se descarta la entrada más
// antigua (los Map de JS iteran en orden de inserción, así que la primera clave
// es la más vieja).
export const MAX_ENTRADAS = 5000;

const cache = new Map<string, { valor: SituacionTributaria; expira: number }>();

// Consultas EN VUELO, para no pegarle N veces al SII por el mismo RUT cuando
// llegan N pedidos antes de que el primero resuelva. El caché de resultados no
// cubre ese caso —todavía no hay resultado que cachear— y es justo el escenario
// que motiva el caché: varios tenants preguntando por la misma empresa a la vez.
// Se guarda la PROMESA y se borra en cuanto se asienta, así un fallo no queda
// pegado para los que vengan después.
const enVuelo = new Map<string, Promise<SituacionTributaria>>();

// Para los tests: el caché es estado de módulo y filtraría entre casos.
export function limpiarCacheSituacionTributaria(): void {
  cache.clear();
  enVuelo.clear();
}

export async function situacionTributaria(
  rut: string,
  transporte?: TransporteSituacion
): Promise<SituacionTributaria> {
  // La clave se normaliza: "22.222.222-2", "22222222-2" y "222222222" son el
  // mismo contribuyente y tienen que compartir entrada. Si el RUT no se puede
  // partir, se consulta sin cachear y que falle donde corresponde.
  let clave: string | null = null;
  try {
    const { rut: cuerpo, dv } = partirRut(rut);
    clave = `${cuerpo}-${dv}`;
  } catch {
    clave = null;
  }

  const ahora = Date.now();
  if (clave) {
    const guardado = cache.get(clave);
    if (guardado && guardado.expira > ahora) return copiar(guardado.valor);
    // Vencida: se borra acá y no sólo se ignora, así una entrada que nadie
    // vuelve a pedir no queda ocupando lugar para siempre.
    if (guardado) cache.delete(clave);

    // Ya hay una consulta en curso para este RUT: se espera esa en vez de abrir
    // otra.
    const yaEnCurso = enVuelo.get(clave);
    if (yaEnCurso) return copiar(await yaEnCurso);
  }

  const pedido = consultarSituacionTributaria(rut, transporte);
  if (clave) {
    enVuelo.set(clave, pedido);
  }

  let valor: SituacionTributaria;
  try {
    valor = await pedido;
  } finally {
    if (clave) enVuelo.delete(clave);
  }

  // Sólo se cachea el éxito. Un fallo puede ser transitorio (el portal caído),
  // y guardarlo convertiría un error de un momento en la respuesta de todo el
  // día. `RecursoNoEncontrado` tampoco se cachea: un RUT recién inscripto pasa
  // de "sin datos" a tener datos, y ése es justo el caso donde importa.
  if (clave) {
    if (cache.size >= MAX_ENTRADAS) {
      const masVieja = cache.keys().next().value;
      if (masVieja !== undefined) cache.delete(masVieja);
    }
    cache.set(clave, { valor, expira: ahora + TTL_MS });
  }

  return copiar(valor);
}

// Se devuelve una COPIA y no la entrada del caché: un consumidor que ordene o
// filtre `actividades` in-place estaría mutando lo que van a leer todos los
// demás durante las próximas 24 horas, y el bug aparecería en un tenant que no
// tocó nada.
function copiar(valor: SituacionTributaria): SituacionTributaria {
  return structuredClone(valor);
}
