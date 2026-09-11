import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

// El período es AAAAMM. Desde 2007: la app declara que antes de enero de 2007 el
// F29 se consulta por otra vía.
const periodo = z.number().int()
  .refine(n => {
    const anio = Math.floor(n / 100), mes = n % 100;
    return anio >= 2007 && anio <= 2100 && mes >= 1 && mes <= 12;
  }, 'periodo debe ser AAAAMM, con año 2007-2100 y mes 01-12')
  .describe('Período tributario en formato AAAAMM (ej. 202507)');

// Estado y compacto piden lo mismo: RUT + período.
export const schemaEstadoF29 = {
  rut: z.string().min(1).describe(RUT_DESC),
  periodo,
};

// Se COPIA a propósito, no se alias por identidad (`schemaCompactoF29 =
// schemaEstadoF29`): que hoy tengan la misma forma es un hecho de HOY, no un
// invariante. Con el alias, si mañana a `estado-declaracion` le agregan un
// campo opcional propio de esa ruta, `formulario-compacto` lo heredaría en
// silencio sin que nadie lo decida. Copiando, el día que un contrato cambie
// hay que tocar el otro a mano, que es lo que corresponde para dos rutas que
// son distintas aunque hoy coincidan.
export const schemaCompactoF29 = {
  rut: z.string().min(1).describe(RUT_DESC),
  periodo,
};

// La propuesta pide el período como STRING AAAAMM y no como number, a diferencia
// de `schemaEstadoF29`. Es deliberado: este contrato lo consume AgenticERP, que
// ya maneja el período así en sus otras fuentes, y un number obligaría a los dos
// lados a convertir de ida y de vuelta. La validación es la misma.
export const schemaPropuestaF29 = {
  rut: z.string().min(1).describe(RUT_DESC),
  // Acepta string Y number, y normaliza a string. `estado-declaracion` pide el
  // período como number y ésta como string: son dos contratos distintos bajo el
  // mismo prefijo `/v1/f29`, y una trampa para quien consuma las dos. Aceptar
  // ambos cuesta una coerción y evita un 400 que sólo se explica leyendo el
  // código.
  periodo: z.union([z.string(), z.number().int()])
    .transform(v => String(v))
    .refine(p => /^\d{6}$/.test(p), 'periodo debe ser AAAAMM, por ejemplo "202608"')
    .refine(p => {
      const anio = Number(p.slice(0, 4)), mes = Number(p.slice(4));
      return anio >= 2007 && anio <= 2100 && mes >= 1 && mes <= 12;
    }, 'periodo debe ser AAAAMM, con año 2007-2100 y mes 01-12')
    .describe('Período tributario en formato AAAAMM (ej. "202608")'),
};

// PPM pide lo mismo que la propuesta —RUT y período AAAAMM como string—, y por
// las mismas razones: las dos rutas las consume AgenticERP con el mismo tipo.
//
// Se COPIA a propósito, no se alias por identidad (`schemaPpmF29 =
// schemaPropuestaF29`): que hoy tengan la misma forma es un hecho de HOY, no
// un invariante. Con el alias, si mañana a `propuesta` le agregan un campo
// opcional propio de esa ruta, PPM lo heredaría en silencio sin que nadie lo
// decida. Copiando, el día que un contrato cambie hay que tocar el otro a
// mano, que es lo que corresponde para dos rutas que son distintas aunque
// hoy coincidan.
export const schemaPpmF29 = {
  rut: z.string().min(1).describe(RUT_DESC),
  periodo: z.union([z.string(), z.number().int()])
    .transform(v => String(v))
    .refine(p => /^\d{6}$/.test(p), 'periodo debe ser AAAAMM, por ejemplo "202608"')
    .refine(p => {
      const anio = Number(p.slice(0, 4)), mes = Number(p.slice(4));
      return anio >= 2007 && anio <= 2100 && mes >= 1 && mes <= 12;
    }, 'periodo debe ser AAAAMM, con año 2007-2100 y mes 01-12')
    .describe('Período tributario en formato AAAAMM (ej. "202608")'),
};
