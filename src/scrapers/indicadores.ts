import { LimiteDeConsultasSii, RecursoNoEncontrado } from '../erroresConsulta';

// Indicadores y valores publicados por el SII: UF, UTM/UTA/IPC, dólar,
// corrección monetaria e impuesto de segunda categoría.
//
// Es el único dominio del repo que NO usa sesión: son páginas públicas del
// portal, así que se piden con `fetch` y no hay credencial, cookie jar ni
// SessionManager. Por eso vive aparte y no hereda del resto de los scrapers.
const BASE = 'https://www.sii.cl/valores_y_fechas';

const TIMEOUT_MS = 20_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// El corte por volumen del SII también llega acá: no hay credencial, pero el SII
// cuenta las requests igual (el bloqueo del RCV fue por patrón de uso, no por
// sesión). Se detecta con el mismo criterio que en `http.ts`: la marca sólo vale
// dentro de algo que parezca una página de error.
const LIMITE_DE_CONSULTAS = /Error\s*429|superado el l[ií]mite/i;

// Los meses tal como los escribe el SII en el `<h2>` de cada tabla. Se indexa
// por NOMBRE y nunca por posición, y no es un detalle: **las tablas vienen en
// orden inverso** (Diciembre primero, Enero último) y el año en curso trae sólo
// los meses ya publicados. Asumir "primera tabla = enero" mapearía septiembre
// como enero — números perfectamente plausibles y todos en el mes equivocado.
const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

export interface ValorDiario {
  mes: number;
  dia: number;
  valor: number;
}

export interface ValorMensual {
  mes: number;
  /** Los valores de la fila, en el orden en que los publica el SII. */
  valores: (number | null)[];
}

/**
 * Convierte un número escrito como lo escribe el SII: punto de miles y coma
 * decimal (`40.875,09`).
 *
 * Devuelve `null` para una celda vacía, que NO es un cero: las tablas traen
 * celdas en blanco para los días que el indicador no tiene (feriados, días
 * futuros del mes en curso), y publicar 0 ahí sería inventar un valor.
 *
 * Tampoco acepta `-.-`, que es como el SII escribe "no corresponde" en las
 * tablas de impuesto.
 */
export function numeroChileno(texto: string | undefined): number | null {
  const limpio = (texto ?? '').replace(/&nbsp;/gi, ' ').trim();
  if (limpio === '' || limpio === '-.-' || limpio === '-') return null;

  // Ojo: las páginas del SII NO usan todas el mismo formato. La UF viene con
  // punto de miles y coma decimal ("40.875,09"); el dólar viene con PUNTO
  // decimal y sin miles ("928.16"). Tratar los dos igual convertía 928.16 en
  // 92816 — un tipo de cambio mil veces más alto, perfectamente plausible a
  // simple vista.
  //
  // La regla: si hay coma, la coma es el decimal y los puntos son miles. Si no
  // hay coma y queda UN punto seguido de una o dos cifras, ese punto es decimal;
  // con tres cifras es separador de miles ("1.234" son mil doscientos treinta y
  // cuatro). El caso de un punto con tres decimales exactos es ambiguo por
  // construcción y se resuelve como miles, que es lo que el SII usa en las
  // tablas de montos.
  const soloNumero = limpio.replace(/[^\d.,-]/g, '');
  let normalizado: string;
  if (soloNumero.includes(',')) {
    normalizado = soloNumero.replace(/\./g, '').replace(',', '.');
  } else {
    const m = /^(-?\d+)\.(\d{1,2})$/.exec(soloNumero);
    normalizado = m ? `${m[1]}.${m[2]}` : soloNumero.replace(/\./g, '');
  }
  if (normalizado === '' || normalizado === '-') return null;

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

// La página de corte del SII no trae datos: es un mensaje de error. Una página
// que SÍ trae la tabla del año no es un corte por más que mencione la frase —y
// la menciona, en notas al pie del estilo "si ha superado el límite de
// consultas diarias…".
//
// Buscar la marca en el documento entero convertía esas páginas en un
// LIMITE_SII falso, y ese código le dice al consumidor que espere minutos por
// datos que ya tenía. Acotar la búsqueda a un prefijo no alcanza: en una página
// corta la nota entra en cualquier ventana razonable. El discriminante que sí
// sirve es si hay tabla de datos.
function pareceTablaDeDatos(html: string): boolean {
  // Se reusa `porMes`, que es LA definición de "hay tablas de datos" para este
  // archivo. Una definición propia acá (un `<table` más un nombre de mes en
  // cualquier parte) empezaba igual pero iba a divergir: una página de corte
  // con tabla de maquetado y un "Enero" al pie pasaba como datos y después
  // reventaba con "no se reconocieron las tablas", que apunta al lugar
  // equivocado.
  return porMes(html).length > 0;
}

function assertNoEsCorte(html: string): void {
  const inicio = html.slice(0, 400);
  const esHtml = /<\s*(!doctype|html|head|body)\b/i.test(inicio);
  if (esHtml && LIMITE_DE_CONSULTAS.test(html) && !pareceTablaDeDatos(html)) {
    throw new LimiteDeConsultasSii(
      'El SII cortó las consultas por volumen (su error 429). Hay que ESPERAR: ' +
      'reintentar de inmediato mantiene el corte.'
    );
  }
}

async function bajar(ruta: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE}/${ruta}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // `fetch` de Node se anuncia como `node`. El resto del repo llega al SII
      // por navegador, y el bloqueo del portal es por patrón de uso: un tráfico
      // que se declara script es exactamente el patrón que se quiere evitar.
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es-CL,es;q=0.9' },
    });
  } catch (e) {
    const causa = (e as Error)?.name === 'TimeoutError' ? 'expiró el tiempo de espera' : 'falló la conexión';
    // La causa original se encadena: sin esto, un DNS que no resuelve y un TLS
    // vencido producen el MISMO mensaje, y quien opera no tiene por dónde
    // empezar a mirar.
    //
    // Se asigna la propiedad en vez de usar el segundo argumento de `Error`
    // porque `lib` está en ES2020 y `ErrorOptions` es de ES2022. Node la
    // soporta igual en runtime; subir el target del repo entero por esto sería
    // un cambio mucho más grande que el arreglo.
    const error = new Error(`No se pudo consultar el SII: ${causa}.`);
    (error as Error & { cause?: unknown }).cause = e;
    throw error;
  }

  // El 404 de estas páginas es informativo: significa que el SII no publicó ese
  // año. Es permanente para años viejos que nunca existieron, así que va como
  // NO_ENCONTRADO y no como fallo transitorio que el consumidor reintente.
  if (resp.status === 404) {
    throw new RecursoNoEncontrado(`El SII no publica esta tabla para el año pedido (${ruta}).`);
  }
  if (!resp.ok) {
    throw new Error(`El SII respondió ${resp.status} al pedir ${ruta}.`);
  }

  // Latin1 como todo el SII: `resp.text()` asume UTF-8 y rompe los acentos, y
  // acá los nombres de mes son justamente lo que se usa para indexar.
  const html = Buffer.from(await resp.arrayBuffer()).toString('latin1');
  assertNoEsCorte(html);
  return html;
}

// Cada tabla del SII abre con `<h2>NombreDelMes</h2>`. Se parte por ahí y se
// devuelve el mes junto a su trozo de HTML.
function porMes(html: string): { mes: number; trozo: string }[] {
  const bloques: { mes: number; trozo: string }[] = [];
  // `h2` y `h3`: la UF titula sus meses con h2 y el dólar con h3. Buscar sólo uno
  // devolvía cero filas para el otro, y en silencio — una lista vacía se lee como
  // "el SII no publicó nada" en vez de "el parser no encontró las tablas".
  // El encabezado es el nombre del mes, y en algunas tablas trae el año pegado
  // ("Diciembre 2025"): se toma la primera palabra y se ignora el resto.
  const marcas = [...html.matchAll(/<h([23])(?:\s[^>]*)?>\s*([A-Za-zÁÉÍÓÚáéíóúñÑ]+)[^<]*<\/h\1>/gi)];

  for (const [i, m] of marcas.entries()) {
    const nombre = m[2].toLowerCase()
      // El SII escribe los meses con acentos según la página; se normalizan para
      // que la clave no dependa de eso.
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    const mes = MESES[nombre];
    if (!mes) continue;
    const desde = (m.index ?? 0) + m[0].length;
    // El bloque termina donde cierra SU tabla, no donde empieza la siguiente ni
    // al final del documento. Tomar hasta `html.length` para el último mes
    // arrastraba todo lo que viene después —y la página repite contenido al pie—,
    // así que enero (que es el ÚLTIMO por el orden inverso) salía con sus 31 días
    // DUPLICADOS: 62 en vez de 31. El total del año daba 396 en lugar de 365, y
    // cada día repetido con el mismo valor, o sea invisible salvo contando.
    const fin = html.indexOf('</table>', desde);
    const siguiente = i + 1 < marcas.length ? marcas[i + 1].index ?? html.length : html.length;
    const hasta = Math.min(fin === -1 ? html.length : fin, siguiente);
    bloques.push({ mes, trozo: html.slice(desde, hasta) });
  }
  return bloques;
}

function celdas(fila: string): string[] {
  return [...fila.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim());
}

function filas(trozo: string): string[] {
  return trozo.split(/<tr[^>]*>/i).slice(1);
}

/**
 * Tablas de valor diario (UF, dólar). Cada fila trae TRES pares día/valor —los
 * días 1-11-21, 2-12-22, y así— no un día por fila.
 *
 * Se emite sólo lo que el SII informa: un día con celda vacía no aparece, en vez
 * de aparecer con 0. Así el consumidor distingue "el SII no publicó ese día" de
 * "el valor es cero", que en un tipo de cambio no es lo mismo.
 */
export function parsearValoresDiarios(html: string): ValorDiario[] {
  const salida: ValorDiario[] = [];
  const bloques = porMes(html);
  assertReconocioTablas(bloques.length);

  for (const { mes, trozo } of bloques) {
    for (const fila of filas(trozo)) {
      const c = celdas(fila);
      // Pares (día, valor). Una fila de cabecera no tiene números en la posición
      // del día, así que se descarta sola.
      // Los pares se leen por posición, así que una fila con un número IMPAR de
      // celdas correría todos los pares siguientes y dejaría cada valor en el día
      // equivocado: números plausibles y mal, que es lo que este archivo trata de
      // evitar. Se descarta la fila entera.
      if (c.length % 2 !== 0) continue;
      for (let i = 0; i + 1 < c.length; i += 2) {
        const dia = Number(c[i].replace(/\D/g, ''));
        const valor = numeroChileno(c[i + 1]);
        if (!Number.isInteger(dia) || dia < 1 || dia > 31) continue;
        if (valor === null) continue;
        salida.push({ mes, dia, valor });
      }
    }
  }
  return salida;
}

/**
 * Tablas de una fila por mes (UTM/UTA/IPC, corrección monetaria). El SII pone el
 * nombre del mes en la primera celda y los valores a continuación.
 *
 * Los valores se devuelven como lista y no con nombres propios: las columnas
 * cambian entre indicadores, y ponerles nombre acá obligaría a inventar una
 * semántica por tabla. Quien consume la ruta sabe qué pidió.
 */
export function parsearValoresMensuales(html: string): ValorMensual[] {
  // Se recorre TABLA por tabla y se elige la que tenga MÁS filas de mes, no el
  // HTML entero: la página trae notas al pie, y una nota que arranque con un
  // nombre de mes ("Enero es el mes base…") se colaba como fila de datos.
  // `vistos` evitaba el duplicado pero se quedaba con la PRIMERA aparición, que
  // no es necesariamente la de la tabla buena; y quedarse con la primera tabla
  // que tenga algún mes tiene el mismo problema si la nota va arriba. La tabla de
  // datos es la que trae los doce meses, así que gana por cantidad.
  let mejor: ValorMensual[] = [];
  for (const tabla of html.split(/<table[^>]*>/i).slice(1)) {
    const valores = filasDeMes(tabla.split(/<\/table>/i)[0]);
    if (valores.length > mejor.length) mejor = valores;
  }
  assertReconocioTablas(mejor.length);
  return mejor;
}

// El parser de tramos ya falla ruidosamente cuando no reconoce ningún rótulo;
// estos dos devolvían `[]`. La diferencia importa porque el consumidor lee la
// lista vacía como "el SII no publicó estos valores", que es una afirmación
// sobre los datos del SII — falsa, y hecha por nosotros. Un rediseño de la
// página (que ya pasó: la UF titula con h2 y el dólar con h3) tiene que dar
// error, no un año sin datos.
//
// No colisiona con el caso legítimo de año no publicado: ese llega como 404 y
// sale por `RecursoNoEncontrado` antes de parsear nada.
function assertReconocioTablas(cuantas: number): void {
  if (cuantas === 0) {
    throw new Error(
      'No se reconocieron las tablas de la página del SII: cambió su estructura. ' +
      'Esto NO significa que el SII no haya publicado los valores.'
    );
  }
}

function filasDeMes(tabla: string): ValorMensual[] {
  const salida: ValorMensual[] = [];
  const vistos = new Set<number>();

  for (const fila of filas(tabla)) {
    const c = celdas(fila);
    if (c.length < 2) continue;

    const nombre = c[0].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const mes = MESES[nombre];
    // Sólo filas que empiezan con un nombre de mes: así se saltan cabeceras y
    // filas de totales sin tener que contarlas.
    if (!mes || vistos.has(mes)) continue;
    vistos.add(mes);

    salida.push({ mes, valores: c.slice(1).map(numeroChileno) });
  }
  return salida.sort((a, b) => a.mes - b.mes);
}

export async function uf(anio: number): Promise<ValorDiario[]> {
  return parsearValoresDiarios(await bajar(`uf/uf${anio}.htm`));
}

export async function dolar(anio: number): Promise<ValorDiario[]> {
  return parsearValoresDiarios(await bajar(`dolar/dolar${anio}.htm`));
}

export async function utm(anio: number): Promise<ValorMensual[]> {
  return parsearValoresMensuales(await bajar(`utm/utm${anio}.htm`));
}

export async function correccionMonetaria(anio: number): Promise<ValorMensual[]> {
  return parsearValoresMensuales(await bajar(`correccion_monetaria/correccion${anio}.htm`));
}

/**
 * Tramos del impuesto único de segunda categoría (artículo 43 y artículo 52 bis).
 *
 * La tabla es una por mes y por período: MENSUAL, QUINCENAL, SEMANAL y DIARIO.
 * El SII escribe el período UNA sola vez y deja la celda vacía en los tramos que
 * siguen, así que se arrastra hacia abajo — leer sólo las filas que lo traen
 * perdería todos los tramos menos el primero de cada período.
 *
 * El primer tramo es exento: no tiene factor ni tasa, y viene con la marca
 * `-.-`. Se publica con `exento: true` y los números en null, en vez de un cero
 * que se leería como "factor cero" y daría el mismo impuesto por otro camino.
 */
export interface TramoImpuesto {
  mes: number;
  periodo: string;
  desde: number | null;
  hasta: number | null;
  factor: number | null;
  rebaja: number | null;
  tasaMaxima: number | null;
  exento: boolean;
}

const PERIODOS = new Set(['MENSUAL', 'QUINCENAL', 'SEMANAL', 'DIARIO']);

export function parsearTramosImpuesto(html: string): TramoImpuesto[] {
  const salida: TramoImpuesto[] = [];
  let bloques = 0;

  for (const { mes, trozo } of porMes(html)) {
    bloques++;
    let periodo = '';
    for (const fila of filas(trozo)) {
      const c = celdas(fila);
      if (c.length < 6) continue;

      const primera = c[0].toUpperCase().trim();
      if (PERIODOS.has(primera)) periodo = primera;
      // Sin período todavía es cabecera: las tres filas del <thead> tienen seis
      // celdas igual, así que contar columnas no alcanza para descartarlas.
      if (periodo === '') continue;

      const exento = /exento/i.test(c[3]);
      salida.push({
        mes,
        periodo,
        desde: numeroChileno(c[1]),
        hasta: numeroChileno(c[2]),
        factor: exento ? null : numeroChileno(c[3]),
        rebaja: exento ? null : numeroChileno(c[4]),
        tasaMaxima: exento ? null : numeroChileno(c[5].replace('%', '')),
        exento,
      });
    }
  }
  // Una página con tablas por mes pero CERO tramos no es "el SII no publicó": es
  // que el rótulo del período dejó de reconocerse —otra capitalización, otro
  // nombre en la página del art. 52 bis, que es aparte— y el resultado sería un
  // array vacío que se lee como dato. Mismo criterio que el h2/h3 de `porMes`.
  if (bloques > 0 && salida.length === 0) {
    throw new Error(
      'El SII devolvió tablas por mes pero ningún tramo reconocible: '
      + 'cambió el rótulo del período y hay que actualizar el scraper.');
  }
  return salida;
}

export async function impuesto2daCategoria(anio: number): Promise<TramoImpuesto[]> {
  return parsearTramosImpuesto(await bajar(`impuesto_2da_categoria/impuesto${anio}.htm`));
}

export async function impuesto2daCategoriaArt52(anio: number): Promise<TramoImpuesto[]> {
  return parsearTramosImpuesto(await bajar(`impuesto_2da_categoria/impuesto${anio}_art52.htm`));
}
