// Piezas compartidas de la aplicación `propuestaf29ui` del SII ("Declarar y
// Pagar F29"). Vive acá y no en cada scraper porque ya son dos —la propuesta de
// casilleros y la tasa de PPM— y las dos trampas de esta app son comunes:
//
//   1. El NAMESPACE es `lob.iva`, no `lob.diii` como el resto del repo.
//   2. El modo de fallo es HTTP 200 con `metaData.errors` y `data` vacía, que
//      quien no lo verifica lee como "no hay dato".
//
// Relevada el 2026-09-06:
// docs/relevamientos/2026-09-06-f29-propuesta-y-asistentes.md
const BASE = 'https://www4.sii.cl/propuestaf29ui/services/data';
const NS = 'cl.sii.sdi.lob.iva.propuestaf29.data.api.interfaces';

export const URL_ADAPTER = `${BASE}/facadeAdapterService`;
export const NS_ADAPTER = `${NS}.FacadeAdapterService`;

// El F29 es el formulario 2 en el catálogo interno del SII (no 29: 29 es su
// nombre público). Sale de la captura del formulario real.
export const FORM_CODIGO = '2';
export const FORM_ID = '2';

/**
 * Lanza si el sobre SDI trae errores. Va acá y no en cada llamada porque el modo
 * de fallo de esta app es traicionero: responde HTTP 200 con `metaData.errors` y
 * `data` vacía, así que un error no verificado se lee como "no hay dato".
 *
 * Mira el CONTENIDO de `errors` y no su presencia: `errors: []` es truthy, y
 * verificar la existencia haría fallar toda consulta exitosa que traiga la lista
 * vacía.
 */
export function assertSinErrores(
  respuesta: { metaData?: { errors?: unknown } } | null,
  queSePedia: string
): void {
  const errores = respuesta?.metaData?.errors;
  const hayError = Array.isArray(errores) ? errores.length > 0 : errores != null;
  if (!hayError) return;

  // El texto del SII se ACOTA antes de entrar al mensaje. Este error termina en
  // `console.error` (ver `rest/rutas/comun.ts`), y `errors[].descripcion` es texto
  // libre de una aplicación que en otros campos manda RUT y razón social: un día
  // trae uno y queda en los logs. Se corta a lo que alcanza para diagnosticar.
  const crudo = Array.isArray(errores)
    ? errores.map((e: { descripcion?: string }) => e?.descripcion).filter(Boolean).join('; ')
    // Si no es un array, se serializa igual: perder toda pista del fallo deja al
    // operador sin nada que mirar.
    : JSON.stringify(errores);
  const descripcion = (crudo ?? '').slice(0, 200);
  throw new Error(
    `El SII rechazó la consulta de ${queSePedia}${descripcion ? `: ${descripcion}` : ''}.`);
}
