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

// Un RUT no es el único dato personal que puede filtrarse: una fixture con una
// declaración de renta completa trajo correo del contribuyente e IP pública de
// presentación, y el chequeo —que sólo miraba RUT— la dejó pasar. Estos dos
// patrones tienen forma reconocible y baja tasa de falsos positivos, que es la
// condición para que el chequeo siga encendido: uno que grita por cualquier
// cosa termina desactivado, y eso es peor que no tenerlo.
const CORREO = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

// Dominios reservados para ejemplos y los que el proyecto usa en fixtures: un
// correo con estos dominios no puede ser de una persona real.
const DOMINIOS_DE_EJEMPLO = /(^|\.)(ejemplo\.cl|example\.(com|org|net)|localhost|invalid)$/i;
const DOMINIO_DE_PRUEBA = /(^|[.-])test([.-]|$)/i;

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

// Rangos que NO son dato personal y son legítimos en fixtures y documentación:
// privados (RFC 1918), loopback, link-local, "esta red", broadcast y los tres
// bloques de documentación de la RFC 5737. Todo lo demás es una IP pública, o
// sea potencialmente la IP desde la que se presentó una declaración real.
function esIpNoPersonal(o: number[]): boolean {
  const [a, b] = o;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  // RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24.
  if (a === 192 && b === 0 && o[2] === 2) return true;
  if (a === 198 && b === 51 && o[2] === 100) return true;
  if (a === 203 && b === 0 && o[2] === 113) return true;
  return false;
}

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
//   3. Nombres, razones sociales, direcciones y comunas reales no se chequean:
//      no tienen forma reconocible, y cualquier heurística sobre texto libre
//      daría falsos positivos constantes hasta que alguien apague el chequeo.
//   4. Montos reales (honorarios, sueldos, base imponible) tampoco. Un monto es
//      un número más entre folios, códigos y totales de fixture: no hay forma
//      de distinguir el real del inventado. La fixture de renta que motivó
//      ampliar esto se detecta ahora por su correo y su IP, no por sus montos.
//   5. Fechas, folios, números de teléfono y patentes quedan fuera por lo
//      mismo: se confunden con datos sintéticos legítimos.
//   6. Un correo con dominio real pero buzón inventado se marca igual (falso
//      positivo deliberado): es preferible a dejar pasar uno verdadero, y se
//      resuelve reescribiéndolo con @ejemplo.cl.

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

// Devuelve los correos que no son de un dominio de ejemplo o de prueba.
export function extraerCorreosSospechosos(contenido: string): string[] {
  const encontrados: string[] = [];
  for (const m of contenido.matchAll(CORREO)) {
    const dominio = m[1];
    if (DOMINIOS_DE_EJEMPLO.test(dominio) || DOMINIO_DE_PRUEBA.test(dominio)) continue;
    encontrados.push(m[0]);
  }
  return encontrados;
}

// Devuelve las IPv4 públicas: las privadas y las de documentación son
// legítimas en fixtures y no identifican a nadie.
// Los productos que pueden anteceder a un número de versión de cuatro partes en
// un User-Agent. Es lista cerrada a propósito: cualquier nombre que se agregue
// acá deja de ser vigilado, así que agregarlo tiene que ser una decisión.
const PRODUCTOS_DE_USER_AGENT = [
  'Mozilla', 'AppleWebKit', 'Chrome', 'Safari', 'Firefox', 'Gecko', 'Edg', 'Version', 'OPR',
];

export function extraerIpsSospechosas(contenido: string): string[] {
  const encontrados: string[] = [];
  for (const m of contenido.matchAll(IPV4)) {
    const octetos = m.slice(1, 5);
    // Un octeto fuera de rango o con cero a la izquierda no es una IP: así se
    // descartan los códigos de error del SII (01.01.190.500.720.27) y los
    // números de versión, que si no serían ruido permanente.
    if (octetos.some(o => (o.length > 1 && o.startsWith('0')) || Number(o) > 255)) continue;
    if (esIpNoPersonal(octetos.map(Number))) continue;
    // Un cuádruple precedido por `producto/` es un número de VERSIÓN, no una IP:
    // el caso real es el `Chrome/126.0.0.0` del User-Agent con que el scraper de
    // indicadores se presenta al SII. Se descarta acá y no relajando el rango de
    // octetos, que taparía IPs públicas de verdad.
    //
    // El nombre del producto tiene que arrancar la palabra —inicio de línea o
    // espacio—, y NO valer si viene después de otra barra. Una primera versión
    // pedía sólo "letra seguida de barra" y con eso
    // `https://cdn.ejemplo.com/servers/8.8.4.4` quedaba exento: una IP pública al
    // final de un path dejaba de detectarse, o sea el chequeo se debilitaba justo
    // donde una IP real aparecería.
    //
    // Y el producto tiene que ser uno de los que aparecen en un User-Agent, no
    // cualquier palabra: con la versión laxa, un `servidor/8.8.4.4` en un log o
    // un `backend/8.8.4.4` en documentación quedaban exentos y el chequeo dejaba
    // pasar una IP real. La exención existe por el User-Agent del repo, así que
    // se limita a él.
    // Sin la bandera `i`: los productos de un User-Agent se escriben con
    // mayúscula fija ("Chrome/", "Safari/"), y con `i` un `version/8.8.4.4`
    // cualquiera en un documento quedaba eximido gratis.
    if (new RegExp(`(?:^|\\s)(${PRODUCTOS_DE_USER_AGENT.join('|')})\\/$`)
      .test(contenido.slice(0, m.index))) continue;
    encontrados.push(m[0]);
  }
  return encontrados;
}

// Punto único de entrada del chequeo: agrega todos los detectores para que
// agregar uno nuevo no exija tocar también el recorrido de archivos.
export function extraerDatosPersonales(contenido: string): string[] {
  return [
    ...extraerRutsSospechosos(contenido),
    ...extraerCorreosSospechosos(contenido),
    ...extraerIpsSospechosas(contenido),
  ];
}
