// Ritmo de las consultas al SII, para que un relevamiento no parezca un ataque.
//
// El SII bloquea a los scrapers. No es una suposición: un barrido de este repo
// —más de doscientas llamadas al portal del RCV en pocos minutos, nueve métodos
// por cinco tipos de documento por tres períodos— terminó con TODAS las
// consultas de RCV respondiendo error mientras otros portales del mismo SII
// seguían contestando bien. O sea que el bloqueo es por servicio y por patrón de
// uso, no por credencial.
//
// La consecuencia práctica: un relevamiento tiene que pasar desapercibido. Vale
// más tardar veinte minutos y obtener el dato que barrer en dos y quedar
// bloqueado, porque el bloqueo no sólo corta el relevamiento — deja al SERVICIO
// sin poder consultar ese portal para los tenants reales.
//
// Este módulo es para los scripts de relevamiento y diagnóstico. Las consultas
// que atienden a un tenant NO pasan por acá: son una por request y las serializa
// `ColaPorClave`.

// Pausa por defecto entre llamadas de un barrido. Es deliberadamente lenta: el
// portal del SII sirve a personas que hacen clic, y una llamada por segundo ya
// es más rápido que cualquier humano. Se puede subir con RITMO_SII_MS para un
// relevamiento largo, pero bajarla es pedir el bloqueo.
const PAUSA_POR_DEFECTO_MS = 1_200;

export function pausaConfigurada(): number {
  const crudo = Number(process.env.RITMO_SII_MS);
  return Number.isFinite(crudo) && crudo >= 0 ? crudo : PAUSA_POR_DEFECTO_MS;
}

export function esperar(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Recorre `items` llamando `fn` de a uno, con pausa entre llamadas.
 *
 * En serie y no en paralelo, por dos razones que se refuerzan: el SII limita las
 * sesiones simultáneas por RUT, y un puñado de requests concurrentes es
 * justamente la firma que delata a un scraper.
 *
 * `tope` corta el barrido: una combinatoria de métodos por tipos por períodos
 * crece rapidísimo, y es fácil escribir un bucle de cien llamadas sin notarlo.
 * Al cortar se avisa, porque un barrido truncado en silencio se lee como "no hay
 * datos" cuando en realidad no se llegó a mirar.
 */
export async function recorrerConRitmo<T, R>(
  items: T[],
  fn: (item: T, indice: number) => Promise<R>,
  opciones: { pausaMs?: number; tope?: number; avisar?: (mensaje: string) => void } = {}
): Promise<R[]> {
  const pausa = opciones.pausaMs ?? pausaConfigurada();
  const tope = opciones.tope ?? Number.POSITIVE_INFINITY;
  const avisar = opciones.avisar ?? ((m: string) => console.log(m));

  if (items.length > tope) {
    avisar(
      `AVISO: el barrido pide ${items.length} llamadas y el tope es ${tope}. ` +
      'Se recortan las que sobran: lo que no se miró NO es "sin datos".'
    );
  }

  const resultados: R[] = [];
  const aRecorrer = items.slice(0, Math.min(items.length, tope));
  for (const [i, item] of aRecorrer.entries()) {
    // La pausa va ANTES de cada llamada salvo la primera: así el ritmo se
    // respeta incluso si el cuerpo lanza y alguien lo envuelve en try/catch.
    if (i > 0 && pausa > 0) await esperar(pausa);
    resultados.push(await fn(item, i));
  }
  return resultados;
}
