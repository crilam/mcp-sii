// Extractor de RUT compartido entre el chequeo de anonimización y sus tests de
// rechazo. Vive en un módulo propio a propósito: cuando el regex estaba
// duplicado en el test, una divergencia dejaba el test en verde sin probar el
// chequeo real. Hay una sola definición y las dos cosas la usan.

// El repositorio es público, así que el control de privacidad no puede mirar
// sólo las fixtures HTML: un RUT real filtrado en un .ts o un .md se publica
// igual. Los llamadores enumeran con `git ls-files` para cubrir exactamente lo
// que se versiona.

// Un RUT de dígito repetido (11111111, 22222222, 33333333) es el convenio de
// datos ficticios del proyecto: el emisor y el receptor de una BHE nunca pueden
// ser el mismo RUT, así que las fixtures necesitan varios ficticios distintos.
const RUT_DE_PRUEBA = /^(\d)\1{6,7}$/;

// Se buscan RUT en dos formas, no "cualquier número largo": un chequeo así se
// llenaría de falsos positivos con montos, folios y códigos de barra.
//   1. Campos de los arreglos del SII cuyo nombre contiene "rut":
//      xml_values['rut_arrastre'] = "12345678" / arr_informe_mensual['rutemisor_1'] = "..."
//   2. RUT escrito con guión y dígito verificador: 12345678-9, 1234567-K.
const CAMPO_RUT = /\w+\['([^']*rut[^']*)'\]\s*=\s*"(\d+)"/gi;
const RUT_CON_DV = /\b(\d{7,8})-([\dkK])\b/g;

// FALSOS NEGATIVOS CONOCIDOS. El chequeo es una red de seguridad, no una
// garantía: se acepta que deje pasar estos casos porque cerrarlos exigiría
// heurísticas que se llenarían de falsos positivos sobre montos y folios. Quien
// anonimice una fixture nueva tiene que revisarla a mano, no confiar en que el
// verde signifique "no quedó nada":
//   1. Un RUT embebido dentro de otro valor no se detecta, porque el nombre del
//      campo no contiene "rut" y el RUT no está delimitado. El caso real es
//      `codigobarras_N`, que arranca con el RUT del emisor concatenado con el
//      resto del código (por ejemplo "011111111134364C969E7").
//   2. Un RUT escrito con puntos ("11.111.111-1") no matchea RUT_CON_DV: el
//      patrón espera el cuerpo sin separadores de miles.
//   3. Nombres, direcciones y comunas reales no se chequean en absoluto. Nada
//      acá mira texto libre, así que una razón social o un domicilio verdadero
//      pasa sin ruido.

// Rutas versionadas que contienen RUT de ejemplo a propósito y no son dato real:
// este módulo (documenta el formato) y el test que lo ejercita.
const EXCLUIDOS = [
  'tests/anonimizacion.ts',
  'tests/anonimizacion.test.ts',
];

export function esRutaExcluida(ruta: string): boolean {
  return EXCLUIDOS.some(e => ruta === e || ruta.endsWith(`/${e}`));
}

// Devuelve los RUT que aparecen en el contenido y NO son ficticios.
export function extraerRutsSospechosos(contenido: string): string[] {
  const encontrados: string[] = [];

  for (const m of contenido.matchAll(CAMPO_RUT)) {
    if (!RUT_DE_PRUEBA.test(m[2])) encontrados.push(m[2]);
  }
  for (const m of contenido.matchAll(RUT_CON_DV)) {
    // El filtro de ficticio corre sobre el cuerpo (el DV de un RUT ficticio no
    // es fijo), pero se reporta con DV para que el hallazgo sea accionable.
    if (!RUT_DE_PRUEBA.test(m[1])) encontrados.push(`${m[1]}-${m[2]}`);
  }

  return encontrados;
}
