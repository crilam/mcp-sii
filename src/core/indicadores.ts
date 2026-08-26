import * as scraper from '../scrapers/indicadores';
import { ValorDiario, ValorMensual, TramoImpuesto } from '../scrapers/indicadores';

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

// Techo de entradas: son ~15 KB por año-indicador, así que 200 entradas son
// ~3 MB. Con seis indicadores eso cubre más de treinta años, o sea todo lo que
// el SII publica.
export const MAX_ENTRADAS = 200;

type Entrada = { valor: unknown; expira: number };
const cache = new Map<string, Entrada>();

export function limpiarCacheIndicadores(): void {
  cache.clear();
}

function expiracion(anio: number, ahora: number): number {
  // `new Date(ahora)` y no `new Date()`: el año en curso se decide con el mismo
  // reloj que el resto de la función, para que un test pueda fijarlo.
  const anioActual = new Date(ahora).getFullYear();
  // Un año cerrado no se vuelve a consultar nunca. Un año FUTURO tampoco se
  // cachea para siempre: el SII puede publicarlo más adelante.
  return anio < anioActual ? Number.POSITIVE_INFINITY : ahora + TTL_ANIO_EN_CURSO_MS;
}

async function conCache<T>(clave: string, anio: number, fn: () => Promise<T>): Promise<T> {
  const ahora = Date.now();
  const guardado = cache.get(clave);
  if (guardado && guardado.expira > ahora) return guardado.valor as T;
  if (guardado) cache.delete(clave);

  const valor = await fn();

  // Sólo se cachea el éxito: un fallo puede ser del momento —el portal caído, un
  // corte por volumen— y guardarlo convertiría un problema de un rato en la
  // respuesta de todo el día.
  if (cache.size >= MAX_ENTRADAS) {
    const masVieja = cache.keys().next().value;
    if (masVieja !== undefined) cache.delete(masVieja);
  }
  cache.set(clave, { valor, expira: expiracion(anio, ahora) });
  return valor;
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
