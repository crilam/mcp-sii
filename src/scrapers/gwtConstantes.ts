// Descubre las dos constantes de un sobre GWT-RPC que cambian cada vez que el
// SII recompila una app GWT: la permutación (`X-GWT-Permutation`) y el hash de
// la política de serialización del servicio (segundo campo del sobre).
//
// Con un hash viejo el servidor no encuentra la política y cae al modo legado,
// que sólo acepta tipos `IsSerializable`: responde
// `IncompatibleRemoteServiceException` aunque el sobre esté bien armado. Eso le
// pasó al F29 en octubre de 2026. Los archivos de la app son públicos (no piden
// sesión), así que las constantes se pueden leer de ahí en vez de re-relevarlas
// a mano con el navegador:
//
//   1. `<base>/<modulo>.nocache.js` lista las permutaciones (hashes de 32 hex).
//   2. `<base>/<permutación>.cache.js` (o `.cache.html`) construye cada proxy de
//      servicio con `Tb.call(this, moduleBase, <ruta del servicio>, '<hash>', ...)`;
//      la ruta suele venir en una variable (`Vxh='svcConsulta'`).

export interface ConstantesGwt {
  permutacion: string;
  hashPolitica: string;
}

// Con bordes: un hex más largo (p. ej. un hash de 40) no aporta permutaciones falsas.
const HEX32 = /(?<![0-9A-Fa-f])[0-9A-F]{32}(?![0-9A-Fa-f])/g;

export function extraerPermutaciones(nocache: string): string[] {
  return [...new Set(nocache.match(HEX32) ?? [])];
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Hash de la política del servicio cuya ruta relativa es `rutaServicio`
// (p. ej. `svcConsulta`). Acepta la ruta inline o en una variable del bundle.
export function extraerHashPolitica(bundle: string, rutaServicio: string): string | null {
  const ruta = escaparRegex(rutaServicio);
  const referencias = [`'${ruta}'`, `"${ruta}"`];
  // Variables a las que el bundle asigna la ruta: `Vxh='svcConsulta'`.
  for (const m of bundle.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)=['"]${ruta}['"]`, 'g'))) {
    referencias.push(escaparRegex(m[1]));
  }
  for (const ref of referencias) {
    // La referencia seguida, como argumento, del hash entre comillas. El borde
    // izquierdo evita que `Vxh` calce dentro de otro identificador (`aVxh`).
    const re = new RegExp(`(?<![\\w$])${ref}\\s*,\\s*['"]([0-9A-F]{32})['"]`);
    const m = bundle.match(re);
    if (m) return m[1];
  }
  return null;
}

// Recorre las permutaciones hasta encontrar un bundle que construya el proxy
// del servicio. `get` es el transporte (el del scraper); los archivos son
// estáticos y públicos, así que no hace falta sesión.
export async function descubrirConstantesGwt(
  get: (url: string) => Promise<string>,
  base: string,
  modulo: string,
  rutaServicio: string,
  maxPermutaciones = 8
): Promise<ConstantesGwt> {
  const permutaciones = extraerPermutaciones(await get(`${base}/${modulo}.nocache.js`));
  if (permutaciones.length === 0) {
    throw new Error(`El arranque GWT de ${modulo} no lista permutaciones: la app cambió de forma.`);
  }
  for (const permutacion of permutaciones.slice(0, maxPermutaciones)) {
    for (const ext of ['cache.js', 'cache.html']) {
      // Un 404 no siempre lanza (curl sin -f devuelve la página de error): en ese
      // caso el hash simplemente no aparece y se sigue con la siguiente URL.
      let bundle: string;
      try {
        bundle = await get(`${base}/${permutacion}.${ext}`);
      } catch {
        continue;
      }
      const hashPolitica = extraerHashPolitica(bundle, rutaServicio);
      if (hashPolitica) return { permutacion, hashPolitica };
    }
  }
  throw new Error(`No se encontró el hash de la política de ${rutaServicio} en las permutaciones de ${modulo}.`);
}
