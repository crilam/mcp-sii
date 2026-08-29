import * as scraper from '../scrapers/vehiculos';
import { CategoriaVehiculo, TasacionVehiculo, Equipamiento } from '../scrapers/vehiculos';
import { ColaPorClave } from '../colaPorClave';
import { RecursoNoEncontrado } from '../erroresConsulta';

// Tasación de vehículos: consultas en memoria sobre la planilla anual del SII.
//
// La planilla se baja UNA vez por (año, categoría) y se guarda entera: son
// ~80.000 filas y ~7 MB, y cada consulta —marcas, modelos, una tasación— es un
// filtro sobre ese arreglo. Bajarla por consulta sería absurdo y además es el
// patrón que el SII castiga. Igual que indicadores: un año cerrado no cambia
// nunca; el año en curso se revisa cada seis horas porque el SII la
// "complementa y rectifica" durante el año (lo dice la propia planilla).
const TTL_ANIO_EN_CURSO_MS = 6 * 60 * 60 * 1000;

// Dos categorías por año, y el SII publica XLSX desde 2020: el espacio son unas
// pocas decenas de planillas, pero cada una pesa. Se guardan hasta ocho.
export const MAX_PLANILLAS = 8;

type Entrada = { valor: Promise<scraper.PlanillaTasacion>; expira: number };
const cache = new Map<string, Entrada>();
// Un slot contra el portal: dos tenants pidiendo años distintos no deben bajar
// dos planillas en paralelo.
const cola = new ColaPorClave();
const CLAVE_PORTAL = 'vehiculos';

export function limpiarCacheVehiculos(): void {
  cache.clear();
}

function expiracion(anio: number, ahora: number): number {
  return anio < new Date(ahora).getFullYear() ? Number.POSITIVE_INFINITY : ahora + TTL_ANIO_EN_CURSO_MS;
}

function planilla(anio: number, categoria: CategoriaVehiculo): Promise<scraper.PlanillaTasacion> {
  const clave = `${categoria}:${anio}`;
  const ahora = Date.now();
  const guardada = cache.get(clave);
  if (guardada && guardada.expira > ahora) {
    cache.delete(clave);
    cache.set(clave, guardada);
    return guardada.valor;
  }
  if (guardada) cache.delete(clave);
  if (cache.size >= MAX_PLANILLAS) {
    const masVieja = cache.keys().next().value;
    if (masVieja !== undefined) cache.delete(masVieja);
  }
  const enVuelo = cola.ejecutar(CLAVE_PORTAL, () => scraper.planilla(anio, categoria));
  cache.set(clave, { valor: enVuelo, expira: expiracion(anio, ahora) });
  // Un fallo no se cachea: puede ser del momento.
  enVuelo.catch(() => {
    if (cache.get(clave)?.valor === enVuelo) cache.delete(clave);
  });
  return enVuelo;
}

const norm = (t: string) => t.trim().toLowerCase();

export interface FiltroVehiculo {
  anio: number;
  categoria: CategoriaVehiculo;
}

/** Tipos de vehículo de la planilla (Sedan, SUV, Cabriolet...), sin repetir. */
export async function tipos(f: FiltroVehiculo): Promise<string[]> {
  const p = await planilla(f.anio, f.categoria);
  return [...new Set(p.filas.map(v => v.tipo).filter(Boolean))].sort();
}

/** Marcas, opcionalmente sólo las de un tipo. */
export async function marcas(f: FiltroVehiculo & { tipo?: string }): Promise<string[]> {
  const p = await planilla(f.anio, f.categoria);
  const tipo = f.tipo ? norm(f.tipo) : null;
  return [...new Set(p.filas
    .filter(v => tipo === null || norm(v.tipo) === tipo)
    .map(v => v.marca).filter(Boolean))].sort();
}

export interface Modelo {
  modelo: string;
  versiones: string[];
  aniosFabricacion: number[];
}

/**
 * Modelos de una marca, con sus versiones y los años de fabricación que la
 * planilla tasa. Es lo que hace falta para llegar a una tasación sin conocer el
 * código SII.
 */
export async function modelos(f: FiltroVehiculo & { marca: string }): Promise<Modelo[]> {
  const p = await planilla(f.anio, f.categoria);
  const marca = norm(f.marca);
  const porModelo = new Map<string, { versiones: Set<string>; anios: Set<number> }>();
  for (const v of p.filas) {
    if (norm(v.marca) !== marca) continue;
    const m = porModelo.get(v.modelo) ?? { versiones: new Set<string>(), anios: new Set<number>() };
    if (v.version) m.versiones.add(v.version);
    if (v.anioFabricacion) m.anios.add(v.anioFabricacion);
    porModelo.set(v.modelo, m);
  }
  // Una marca que no existe se dice: una lista vacía se leería como "marca sin
  // modelos", y eso no pasa en la planilla.
  if (porModelo.size === 0) {
    throw new RecursoNoEncontrado(
      `La planilla de tasación ${f.categoria} ${f.anio} no tiene la marca "${f.marca}". `
      + 'Las marcas válidas las devuelve /marcas.');
  }
  return [...porModelo.entries()]
    .map(([modelo, m]) => ({
      modelo,
      versiones: [...m.versiones].sort(),
      aniosFabricacion: [...m.anios].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.modelo.localeCompare(b.modelo));
}

export interface BusquedaTasacion extends FiltroVehiculo {
  codigoSii?: string;
  marca?: string;
  modelo?: string;
  version?: string;
  anioFabricacion?: number;
}

/**
 * Tasaciones que cumplen el filtro. Por código SII, o por marca + modelo (+
 * versión, + año de fabricación). Devuelve TODAS las filas que coinciden: un
 * mismo modelo tiene una fila por año de fabricación y por versión, y elegir
 * una acá sería adivinar cuál quería el consumidor.
 */
export async function tasacion(b: BusquedaTasacion): Promise<TasacionVehiculo[]> {
  if (!b.codigoSii && !(b.marca && b.modelo)) {
    throw new Error('Hace falta codigo_sii, o marca y modelo, para buscar una tasación.');
  }
  const p = await planilla(b.anio, b.categoria);
  const codigo = b.codigoSii ? norm(b.codigoSii) : null;
  const marca = b.marca ? norm(b.marca) : null;
  const modelo = b.modelo ? norm(b.modelo) : null;
  const version = b.version ? norm(b.version) : null;

  const filas = p.filas.filter(v =>
    (codigo === null || norm(v.codigoSii) === codigo)
    && (marca === null || norm(v.marca) === marca)
    && (modelo === null || norm(v.modelo) === modelo)
    && (version === null || norm(v.version) === version)
    && (b.anioFabricacion === undefined || v.anioFabricacion === b.anioFabricacion));

  if (filas.length === 0) {
    throw new RecursoNoEncontrado(
      `La planilla de tasación ${b.categoria} ${b.anio} no tiene un vehículo que cumpla `
      + `${codigo ? `código ${b.codigoSii}` : `${b.marca} ${b.modelo}${b.version ? ` ${b.version}` : ''}`}`
      + `${b.anioFabricacion ? ` año ${b.anioFabricacion}` : ''}.`);
  }
  return filas;
}

/** Diccionario de siglas de equipamiento ("AA" → "Aire Acondicionado"). */
export async function equipamiento(f: FiltroVehiculo): Promise<Equipamiento[]> {
  return (await planilla(f.anio, f.categoria)).equipamiento;
}
