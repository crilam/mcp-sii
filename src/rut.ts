// Partir un RUT en cuerpo y dígito verificador es lo que piden todos los
// servicios del SII, y estaba escrito dos veces: en `SessionManager.identidad()`
// (para el RUT de la sesión) y en el scraper del RCV (para el RUT de la empresa
// consultada). Las dos copias hacían lo mismo salvo por un detalle: una validaba
// el resultado y la otra no, así que un RUT mal escrito fallaba distinto según
// por dónde entrara. Hay una sola definición y las dos la usan.
//
// Acepta las dos formas que se usan en el proyecto ("22222222-2" y "222222222")
// y limpia los puntos, por si el RUT llega escrito como lo muestra el portal.
export function partirRut(rutCompleto: string, descripcion = 'RUT'): { rut: string; dv: string } {
  const limpio = (rutCompleto ?? '').replace(/\./g, '').trim();
  const [rut, dv] = limpio.includes('-')
    ? limpio.split('-')
    : [limpio.slice(0, -1), limpio.slice(-1)];

  // Sin esta validación, un RUT mal escrito no falla: se parte igual y viaja al
  // SII, que responde un vacío indistinguible de "este contribuyente no tiene
  // movimientos". El error aparece como un resultado plausible.
  if (!/^\d{5,9}$/.test(rut) || !/^[\dkK]$/.test(dv ?? '')) {
    throw new Error(`${descripcion} inválido: "${rutCompleto}". Se espera 22222222-2.`);
  }

  return { rut, dv: dv.toUpperCase() };
}

// Dígito verificador por módulo 11. Hasta ahora al proyecto le alcanzaba con la
// forma del RUT porque sólo consultaba; la emisión de DTE es distinta: el
// portal valida el DV del receptor y, si no cuadra, no responde un error sino
// el formulario de vuelta. Sin este chequeo, un RUT con un dígito cambiado se
// lee como "no se pudo previsualizar" en vez de "el RUT está mal".
export function digitoVerificador(rut: string): string {
  let suma = 0;
  let factor = 2;
  for (let i = rut.length - 1; i >= 0; i--) {
    suma += parseInt(rut[i], 10) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return '0';
  if (resto === 10) return 'K';
  return String(resto);
}

export function rutEsValido(rut: string, dv: string): boolean {
  if (!/^\d{5,9}$/.test(rut ?? '') || !/^[\dkK]$/.test(dv ?? '')) return false;
  return digitoVerificador(rut) === dv.toUpperCase();
}
