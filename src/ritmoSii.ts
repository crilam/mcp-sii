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
// Este módulo es, sobre todo, para los scripts de relevamiento y diagnóstico:
// casi todas las consultas que atienden a un tenant son UNA por request y las
// serializa `ColaPorClave`, así que no necesitan ritmo propio.
//
// La excepción es `MipymeHttpScraper.respaldoXml`, que sí lo usa desde una ruta
// REST. No es una violación de la regla sino su caso límite: el SII no entrega
// más de 20 documentos por descarga, o sea que cubrir un rango obliga a varias
// llamadas seguidas al mismo CGI DENTRO de una request — que es exactamente el
// patrón que este módulo existe para amortiguar. El techo de tramos de esa ruta
// es la otra mitad de la protección: la pausa evita el barrido rápido, el techo
// evita el barrido largo.

// Pausa por defecto entre llamadas de un barrido. Es deliberadamente lenta: el
// portal del SII sirve a personas que hacen clic, y una llamada por segundo ya
// es más rápido que cualquier humano.
//
// Exportada (sin cambiar su valor) para que quien necesite el mismo PISO fuera
// de `recorrerConRitmo` —hoy, `verificarRespaldoXml.ts` validando `pausa_ms`
// de un plan leído de archivo— lo reuse en vez de escribir el número de nuevo,
// que divergiría en silencio si este cambiara.
export const PAUSA_POR_DEFECTO_MS = 1_200;

/**
 * Pausa a usar. `RITMO_SII_MS` sólo puede hacerla MÁS lenta: el defecto es un
 * piso, no una sugerencia.
 *
 * Dos formas de quedarse sin pausa que hay que cerrar explícitamente, porque las
 * dos fallan en silencio y el síntoma aparece recién como portal bloqueado:
 *
 *   - `RITMO_SII_MS=""` — una variable definida y vacía es de lo más común en un
 *     deploy, y `Number("")` es 0, no NaN. Un guard que sólo mire `isFinite` la
 *     acepta y deja el barrido a toda velocidad.
 *   - `RITMO_SII_MS=0` — alguien "apurando" un relevamiento. El piso lo ignora.
 */
export function pausaConfigurada(): number {
  const crudo = process.env.RITMO_SII_MS;
  if (crudo == null || crudo.trim() === '') return PAUSA_POR_DEFECTO_MS;

  const ms = Number(crudo);
  if (!Number.isFinite(ms)) return PAUSA_POR_DEFECTO_MS;
  // El defecto es un PISO. Bajarlo es pedir el bloqueo, así que no se permite ni
  // por variable de entorno.
  return Math.max(ms, PAUSA_POR_DEFECTO_MS);
}

export function esperar(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * El tercer nivel de troceo del respaldo XML (folio para emitidos, contraparte
 * para recibidos) combina `TPO_DOC` con `FOLIO`/`FOLIOHASTA` o con `RUT_RECP`
 * en la MISMA llamada al CGI de descarga. Fecha+folio y fecha+contraparte
 * están verificados contra el SII real (ver docs/integracion-api.md).
 *
 * La combinación `TPO_DOC` + `FOLIO`/`FOLIOHASTA` (el eje de emitidos) también
 * se verificó en vivo: una consulta de un día con un mes cargado, con
 * `tipo_dte` fijo y un rango de folio acotado, se midió dos veces con anchos
 * de rango distintos (del orden de mil y de cinco mil) y en las dos el CGI
 * respetó ambos filtros a la vez, entregando documentos reales (6 y 18
 * respectivamente) verificados uno por uno.
 *
 * `TPO_DOC` + `RUT_RECP` (el eje de recibidos) sigue SIN verificación en
 * vivo. No asumir que el resultado de folio se traslada a contraparte sin
 * haberlo medido.
 *
 * IMPORTANTE: `RESPALDO_XML_TERCER_NIVEL` es un interruptor único que
 * habilita LOS DOS EJES A LA VEZ, sin granularidad — no existe forma de
 * prender folio (verificado) y dejar contraparte (no verificado) apagado.
 * Prenderlo en un ambiente que reciba consultas de `recibidos` habilita
 * también el eje no medido. Por eso, aunque el eje de folio ya esté
 * verificado, el tercer nivel completo queda APAGADO por defecto: `false` a
 * menos que la variable sea `'1'` o `'true'` (sin importar mayúsculas).
 * Prenderlo abre un eje más de llamadas contra un portal que bloquea por
 * patrón de uso, así que activarlo en producción es una decisión de
 * despliegue que se toma a conciencia, no un default. Antes de activarlo en
 * un ambiente que atienda `recibidos` hay que verificar en vivo el eje de
 * contraparte primero (con `src/scripts/verificarRespaldoXml.ts`), igual que
 * ya se hizo para folio.
 */
export function tercerNivelHabilitado(): boolean {
  const crudo = process.env.RESPALDO_XML_TERCER_NIVEL;
  if (crudo == null) return false;
  return /^(1|true)$/i.test(crudo.trim());
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
