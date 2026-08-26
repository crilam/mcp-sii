import { z } from 'zod';

// El único parámetro es el año, y NO hay credencial: son páginas públicas del
// SII. Es la única familia de rutas del adaptador sin `rut`, y está documentado
// en la guía porque rompe el patrón de todas las demás.
//
// El rango arranca en 1990 y no en 2000 como el resto de los schemas: el SII
// publica UF y UTM desde bastante antes, y cortar en 2000 negaría años que sí
// existen. Un año que el SII no publique devuelve NO_ENCONTRADO, que es la
// respuesta honesta —el 404 de esa página— en vez de un rechazo inventado acá.
export const schemaAnio = {
  anio: z.number().int().min(1990).max(2100)
    .describe('Año de los valores a consultar (AAAA).'),
};
