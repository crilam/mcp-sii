import * as scraper from '../scrapers/indicadores';
import { ColaPorClave } from '../colaPorClave';
import { ValorDiario, ValorMensual, TramoImpuesto } from '../scrapers/indicadores';
import { ServicioOcupado } from '../erroresConsulta';

// Indicadores públicos del SII. No usa `EjecutorSesion` como el resto de los
// core: estas páginas no tienen credencial ni sesión, así que no hay nada que
// encolar por RUT.

// Caché por (indicador, año). El TTL depende de si el año ya cerró: el valor de
// la UF de un día pasado NO cambia nunca, así que un año terminado se puede
// guardar indefinidamente. El año en curso sí cambia —el SII agrega días— y se
// revisa cada seis horas.
//
// Importa más que en otros dominios: cada consulta acá baja una página entera del
// SII para devolver un valor, y el SII corta por volumen. Sin caché, un
// consumidor que convierta cien montos a UF baja cien veces la misma tabla.
const TTL_ANIO_EN_CURSO_MS = 6 * 60 * 60 * 1000;

// Techo de entradas: son ~15 KB por año-indicador, así que 700 entradas son
// ~10 MB. El schema acepta 1990–2100, o sea 111 años × 6 indicadores = 666
// claves posibles: con un techo menor, un solo consumidor recorriendo el rango
// completo vacía el caché de todos los demás, y con la cola de un slot eso
// serializa cientos de bajadas al portal para todo el mundo. El techo cubre el
// espacio entero y sigue siendo un tope, no una promesa de que quepa todo.
export const MAX_ENTRADAS = 700;

// Se guarda la PROMESA en vuelo y no el valor resuelto: así N requests
// concurrentes del mismo año-indicador (caché fría, o recién vencida) comparten
// una sola bajada en vez de disparar N contra el portal. Sin esto, un consumidor
// que arranca con diez conversiones a UF en paralelo hacía diez requests para el
// mismo año.
type Entrada = { valor: Promise<unknown>; expira: number };
const cache = new Map<string, Entrada>();

// Todo el dominio se serializa contra el portal: es el único que NO pasa por la
// `ColaPorClave` de los tenants, así que sin esto varios tenants pidiendo años
// distintos hacen un barrido PARALELO a sii.cl — el patrón exacto que ya bloqueó
// el RCV (ver `ritmoSii.ts`). La clave es fija porque el límite es del portal,
// no del año que se pide.
const cola = new ColaPorClave();
const CLAVE_PORTAL = 'indicadores';

// Tope de bajadas esperando turno. La cola es de un solo turno y el
// `AbortSignal.timeout` de la bajada cubre la CONEXIÓN, no la espera: sin tope,
// un consumidor que pide cincuenta años nuevos deja a los demás colgados
// minutos, con la conexión HTTP abierta y sin error a la vista. Del lado del
// que integra, eso es indistinguible de un servicio caído — y peor, porque no
// tiene con qué decidir reintentar.
//
// Doce es el peor caso legítimo con holgura: un consumidor que arma una tabla
// de un año pide seis indicadores, y dos consumidores haciéndolo a la vez
// entran. Más que eso no es demanda, es una ráfaga.
export const MAX_EN_COLA = 12;

// Cuenta las bajadas EN VUELO: la que está corriendo más las que esperan turno.
// Se llama así y no `esperando` porque con 12 son 11 esperando y 1 corriendo, y
// el nombre anterior hacía leer mal el mensaje de error.
let bajadasEnVuelo = 0;

export function limpiarCacheIndicadores(): void {
  cache.clear();
  // También el contador de la cola: es estado de módulo del mismo mecanismo, y
  // un test que deja bajadas colgadas dejaría el cupo consumido para todos los
  // que siguen en el mismo proceso — fallando por contaminación, no por lo que
  // el test dice probar.
  // `Math.max(0, …)` en el decremento y no sólo el reset: una bajada colgada
  // cuando se limpia sigue teniendo su `finally` pendiente, y sin el piso el
  // contador quedaba NEGATIVO al liberarla — aflojando el tope para todo lo que
  // viniera después, en silencio.
  bajadasEnVuelo = 0;
}

function expiracion(anio: number, ahora: number): number {
  // `new Date(ahora)` y no `new Date()`: el año en curso se decide con el mismo
  // reloj que el resto de la función, para que un test pueda fijarlo.
  const anioActual = new Date(ahora).getFullYear();
  // Un año cerrado no se vuelve a consultar nunca. Un año FUTURO tampoco se
  // cachea para siempre: el SII puede publicarlo más adelante.
  return anio < anioActual ? Number.POSITIVE_INFINITY : ahora + TTL_ANIO_EN_CURSO_MS;
}

function conCache<T>(clave: string, anio: number, fn: () => Promise<T>): Promise<T> {
  const ahora = Date.now();
  const guardado = cache.get(clave);
  if (guardado && guardado.expira > ahora) {
    // Re-insertar en cada acierto vuelve el desalojo LRU en vez de FIFO: el año
    // en curso es de los primeros que entran y el que más se repide, así que un
    // FIFO puro botaba justo la entrada más usada.
    cache.delete(clave);
    cache.set(clave, guardado);
    return guardado.valor as Promise<T>;
  }
  if (guardado) cache.delete(clave);

  // El tope se mira acá y no en la cola: un acierto de caché ya devolvió arriba
  // sin tocar el portal, así que no consume cupo. Contarlo haría que un
  // consumidor que repite el mismo año se auto-bloqueara pidiendo algo que ni
  // siquiera sale a la red.
  //
  // Se devuelve una promesa rechazada y NO se lanza sincrónicamente: todas las
  // demás salidas de esta función son promesas, y un throw síncrono obligaría a
  // cada llamador a envolver la llamada en try/catch ADEMÁS del catch de la
  // promesa. El que se olvide —y alguno se olvida— se lleva una excepción sin
  // capturar en vez de un error de dominio.
  if (bajadasEnVuelo >= MAX_EN_COLA) {
    return Promise.reject(new ServicioOcupado(
      `Hay ${bajadasEnVuelo} consultas de indicadores en curso contra el portal del SII. ` +
      'Reintentá en unos segundos: el servicio serializa las bajadas a propósito, ' +
      'porque un barrido paralelo hace que el SII corte por volumen.'
    ));
  }
  bajadasEnVuelo++;

  // El desalojo LRU va DESPUÉS del tope: un request que va a ser rechazado no
  // tiene por qué botar una entrada de caché válida de paso.
  if (cache.size >= MAX_ENTRADAS) {
    const masVieja = cache.keys().next().value;
    if (masVieja !== undefined) cache.delete(masVieja);
  }


  // La expiración se calcula cuando LLEGA el dato, no cuando se encoló: con la
  // cola serializada, una bajada puede esperar su turno varios segundos y el TTL
  // empezaría a correr antes de tener nada.
  const enVuelo = cola.ejecutar(CLAVE_PORTAL, fn).then(valor => {
    const entrada = cache.get(clave);
    if (entrada?.valor === enVuelo) entrada.expira = expiracion(anio, Date.now());
    return valor;
  }).finally(() => { bajadasEnVuelo = Math.max(0, bajadasEnVuelo - 1); });
  cache.set(clave, { valor: enVuelo, expira: expiracion(anio, ahora) });

  // Sólo se cachea el éxito: un fallo puede ser del momento —el portal caído, un
  // corte por volumen— y guardarlo convertiría un problema de un rato en la
  // respuesta de todo el día. Se borra la entrada, no el `await`: quien ya está
  // colgado de esta promesa recibe el mismo error.
  enVuelo.catch(() => {
    if (cache.get(clave)?.valor === enVuelo) cache.delete(clave);
  });
  return enVuelo;
}

export function uf(anio: number): Promise<ValorDiario[]> {
  return conCache(`uf:${anio}`, anio, () => scraper.uf(anio));
}

export function dolar(anio: number): Promise<ValorDiario[]> {
  return conCache(`dolar:${anio}`, anio, () => scraper.dolar(anio));
}

export function utm(anio: number): Promise<ValorMensual[]> {
  return conCache(`utm:${anio}`, anio, () => scraper.utm(anio));
}

export function correccionMonetaria(anio: number): Promise<ValorMensual[]> {
  return conCache(`correccion:${anio}`, anio, () => scraper.correccionMonetaria(anio));
}

export function impuesto2daCategoria(anio: number): Promise<TramoImpuesto[]> {
  return conCache(`impuesto2da:${anio}`, anio, () => scraper.impuesto2daCategoria(anio));
}

export function impuesto2daCategoriaArt52(anio: number): Promise<TramoImpuesto[]> {
  return conCache(`impuesto2da52:${anio}`, anio, () => scraper.impuesto2daCategoriaArt52(anio));
}
