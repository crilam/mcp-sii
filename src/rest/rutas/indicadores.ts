import { z } from 'zod';
import * as core from '../../core/indicadores';
import { schemaAnio } from '../../core/schemas/indicadores';
import { RutaHandler, ejecutar, badRequest } from './comun';

// Indicadores y valores públicos del SII.
//
// Estas rutas NO reciben credencial ni `rut`, a diferencia de todas las demás
// del adaptador: el SII publica estas tablas abiertas. Tampoco reciben el
// registro de sesiones, porque no hay sesión que abrir — de ahí que la firma de
// esta función sea distinta a la de los otros `registrarRutas*`.
//
// Siguen pasando por el auth de tenant y el rate-limit del servidor, como todas.
const zodAnio = z.object(schemaAnio);

export function registrarRutasIndicadores(rutas: Map<string, RutaHandler>): void {
  const ruta = <T>(nombre: string, fn: (anio: number) => Promise<T>) => {
    rutas.set(`POST /v1/indicadores/${nombre}`, async body => {
      const parseo = zodAnio.safeParse(body);
      if (!parseo.success) return badRequest(parseo.error);
      return ejecutar(() => fn(parseo.data.anio));
    });
  };

  ruta('uf', core.uf);
  ruta('dolar', core.dolar);
  ruta('utm', core.utm);
  ruta('correccion-monetaria', core.correccionMonetaria);
  // Dos rutas y no una con parámetro: son dos tablas distintas del SII, y el
  // artículo 52 bis sólo trae el período mensual.
  ruta('impuesto-2da-categoria', core.impuesto2daCategoria);
  ruta('impuesto-2da-categoria-art52', core.impuesto2daCategoriaArt52);
}
