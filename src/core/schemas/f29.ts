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
// schemaEstadoF29`): la igualdad de hoy no es un invariante, y un alias se la
// heredaría en silencio a la otra ruta el día que una gane un campo propio.
// Copiando, ese día hay que tocar el otro a mano — que es lo que corresponde
// para dos rutas distintas que hoy coinciden. Mismo razonamiento aplica más
// abajo a `schemaPpmF29`, y `tests/core/schemas/f29.test.ts` fija los campos
// de los cuatro esquemas contra una lista explícita: es la red que reemplaza
// al alias que se saca acá.
export const schemaCompactoF29 = {
  rut: z.string().min(1).describe(RUT_DESC),
  periodo,
};

// Regla de formato para el período como STRING AAAAMM (no como number, a
// diferencia de `schemaEstadoF29`): acepta string y number y normaliza a
// string, porque `estado-declaracion` pide el período como number bajo el
// mismo prefijo `/v1/f29` y una trampa para quien consuma las dos rutas.
// Compartida por `schemaPropuestaF29` y `schemaPpmF29` para que un arreglo al
// formato no se aplique en una y se olvide en la otra.
const reglaFormatoPeriodo = z.union([z.string(), z.number().int()])
  .transform(v => String(v))
  .refine(p => /^\d{6}$/.test(p), 'periodo debe ser AAAAMM, por ejemplo "202608"')
  .refine(p => {
    const anio = Number(p.slice(0, 4)), mes = Number(p.slice(4));
    return anio >= 2007 && anio <= 2100 && mes >= 1 && mes <= 12;
  }, 'periodo debe ser AAAAMM, con año 2007-2100 y mes 01-12')
  .describe('Período tributario en formato AAAAMM (ej. "202608")');

export const schemaPropuestaF29 = {
  rut: z.string().min(1).describe(RUT_DESC),
  periodo: reglaFormatoPeriodo,
};

// PPM pide lo mismo que la propuesta —RUT y período AAAAMM como string—, y por
// las mismas razones: las dos rutas las consume AgenticERP con el mismo tipo.
//
// Se COPIA a propósito (ver el razonamiento junto a `schemaCompactoF29`, más
// arriba); sólo la REGLA de formato del período se comparte vía
// `reglaFormatoPeriodo`, no el objeto del esquema completo.
export const schemaPpmF29 = {
  rut: z.string().min(1).describe(RUT_DESC),
  periodo: reglaFormatoPeriodo,
};
