import * as scraper from '../scrapers/actividadesEconomicas';
import { ActividadEconomica } from '../scrapers/actividadesEconomicas';
import { ColaPorClave } from '../colaPorClave';
import { RecursoNoEncontrado } from '../erroresConsulta';

// Códigos de actividad económica: una sola página pública, cacheada entera.
//
// La tabla cambia con resoluciones del SII, no a diario: se revisa una vez al
// día. Igual que indicadores, un fallo no se cachea y las bajadas van por una
// cola de un slot.
const TTL_MS = 24 * 60 * 60 * 1000;
let cache: { valor: Promise<ActividadEconomica[]>; expira: number } | null = null;
const cola = new ColaPorClave();

export function limpiarCacheActividades(): void {
  cache = null;
}

function todas(): Promise<ActividadEconomica[]> {
  const ahora = Date.now();
  if (cache && cache.expira > ahora) return cache.valor;
  const enVuelo = cola.ejecutar('actividades', () => scraper.actividades());
  const entrada = { valor: enVuelo, expira: ahora + TTL_MS };
  cache = entrada;
  enVuelo.catch(() => { if (cache === entrada) cache = null; });
  return enVuelo;
}

export interface FiltroActividades {
  // "1", "2" o el valor que traiga la tabla. apigateway filtra por 1 y 2.
  categoria?: string;
  afectaIva?: boolean;
  texto?: string;
}

/** Listado completo o filtrado por categoría, IVA y texto en la descripción. */
export async function actividades(f: FiltroActividades = {}): Promise<ActividadEconomica[]> {
  const lista = await todas();
  const texto = f.texto?.trim().toLowerCase();
  return lista.filter(a =>
    (f.categoria === undefined || a.categoriaTributaria === f.categoria)
    && (f.afectaIva === undefined || a.afectaIva === f.afectaIva)
    && (!texto || a.descripcion.toLowerCase().includes(texto) || a.subrubro.toLowerCase().includes(texto)
      || a.rubro.toLowerCase().includes(texto)));
}

/** Una actividad por su código de seis dígitos. */
export async function actividad(codigo: string): Promise<ActividadEconomica> {
  const lista = await todas();
  const a = lista.find(x => x.codigo === codigo.trim());
  if (!a) {
    throw new RecursoNoEncontrado(`El SII no tiene un código de actividad económica ${codigo}.`);
  }
  return a;
}

/**
 * Verifica un RUT chileno: formato y dígito verificador (módulo 11). No toca el
 * SII: es aritmética. apigateway lo expone como endpoint y acá se conserva el
 * paralelo, pero no dice si el RUT EXISTE —eso es `situacion-tributaria`—,
 * sólo si está bien formado.
 */
export function verificarRut(entrada: string): { rut: string; valido: boolean; cuerpo: string; dv: string; motivo?: string } {
  const limpio = entrada.replace(/[.\s]/g, '').toUpperCase();
  const m = /^(\d{1,8})-?([\dK])$/.exec(limpio);
  if (!m) {
    return { rut: entrada, valido: false, cuerpo: '', dv: '', motivo: 'El RUT tiene que ser un número de hasta 8 dígitos seguido del dígito verificador (0-9 o K).' };
  }
  const [, cuerpo, dv] = m;
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const esperado = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  const valido = esperado === dv;
  return {
    rut: `${cuerpo}-${dv}`, valido, cuerpo, dv,
    ...(valido ? {} : { motivo: `El dígito verificador de ${cuerpo} es ${esperado}, no ${dv}.` }),
  };
}
