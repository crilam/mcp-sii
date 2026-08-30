// Mínimo indispensable de GWT-RPC para hablarle a la Consulta Integral del F29.
//
// GWT no publica una API: su bundle (`*.nocache.js`) es código compilado y las
// llamadas viajan en un formato serializado propio. Lo que hay acá se relevó
// capturando con el navegador las requests REALES que hace la app al abrir un
// período (ver `relevarF29Rpc.ts`), y reproduce sólo lo necesario: codificar
// enteros largos, y leer la respuesta `//OK[...]`.
//
// No es un cliente GWT general —no deserializa objetos por reflexión—: resuelve
// la respuesta a una lista PLANA de valores (enteros, longs y strings ya
// resueltos por su índice), que es determinista, y el scraper lee de ahí por
// posición y validando la forma. Si el SII recompila la app y cambia el orden,
// la validación de forma lo delata en vez de devolver un dato corrido.

// GWT codifica los enteros largos (`long`) en base64 con este alfabeto y sin
// padding. Es el mismo que usa para folios, RUT y períodos.
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_';

export function codificarLong(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`codificarLong: ${n} no es un entero no negativo.`);
  if (n === 0) return 'A';
  let s = '';
  let v = n;
  while (v > 0) { s = ALFABETO[v % 64] + s; v = Math.floor(v / 64); }
  return s;
}

export function decodificarLong(s: string): number {
  let v = 0;
  for (const ch of s) {
    const i = ALFABETO.indexOf(ch);
    if (i === -1) throw new Error(`decodificarLong: "${s}" tiene un carácter fuera del alfabeto GWT.`);
    v = v * 64 + i;
  }
  return v;
}

export type ValorGwt = number | string;

/**
 * Lee una respuesta GWT-RPC exitosa (`//OK[...]`) y devuelve el "stream" de
 * valores en el ORDEN en que GWT los serializó (del final del arreglo hacia el
 * principio, que es como el cliente los consume), con los índices ya resueltos
 * contra la tabla de strings.
 *
 * Estructura de la respuesta: `//OK[ v0, v1, ..., [tabla de strings], flags,
 * version ]`. Los tres últimos elementos son metadatos; los `vN` son el stream.
 * Un `vN` es un entero literal (posición o valor), un long entre comillas
 * (`'IOFT3a'`), o un índice 1-based a la tabla de strings.
 *
 * Devolver el stream tal cual —sin intentar reconstruir el objeto— es
 * deliberado: reconstruirlo necesitaría el orden de campos del TO de Java, que
 * no tenemos; leer por forma y posición es lo mismo que se hace con cualquier
 * scraping de este repo.
 */
export function leerRespuestaGwt(cuerpo: string): { stream: ValorGwt[]; tabla: string[] } {
  const t = cuerpo.trim();
  if (t.startsWith('//EX')) {
    throw new Error(`GWT respondió una excepción: ${t.slice(0, 300)}`);
  }
  if (!t.startsWith('//OK')) {
    // Sin `//OK` no es una respuesta GWT: es el login, un error del portal o un
    // cambio de la app. No puede leerse como "sin datos".
    throw new Error(`GWT no devolvió //OK (la sesión pudo expirar o la app cambió): ${t.slice(0, 200)}`);
  }
  // El cuerpo NO es JSON: los longs van entre comillas SIMPLES (`'IOFT3a'`) y la
  // tabla de strings entre comillas dobles. La tabla es el único `[...]` interno
  // (JSON válido); se recorta aparte y el resto se tokeniza por coma.
  const cuerpoArr = t.slice(4).trim().replace(/^\[/, '').replace(/\]$/, '');
  const iTabla = cuerpoArr.indexOf('[');
  const jTabla = cuerpoArr.lastIndexOf(']');
  if (iTabla === -1 || jTabla === -1) {
    throw new Error('La respuesta GWT no trae la tabla de strings donde se esperaba.');
  }
  const tabla = JSON.parse(cuerpoArr.slice(iTabla, jTabla + 1)) as string[];

  // Antes de la tabla va el stream; después, `flags` y `version` (metadatos).
  const antes = cuerpoArr.slice(0, iTabla).replace(/,\s*$/, '');
  const tokens = antes === '' ? [] : antes.split(',').map(s => s.trim()).filter(Boolean);

  const stream: ValorGwt[] = tokens.map(tok => {
    if (tok.startsWith("'") && tok.endsWith("'")) return decodificarLong(tok.slice(1, -1));
    const n = Number(tok);
    if (!Number.isInteger(n)) return tok;
    // Índice 1-based POSITIVO a la tabla; 0, negativos y los que exceden la
    // tabla se dejan como enteros (son posiciones/valores del stream).
    if (n >= 1 && n <= tabla.length) return tabla[n - 1];
    return n;
  });

  return { stream, tabla };
}
