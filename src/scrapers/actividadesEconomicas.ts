import { LimiteDeConsultasSii } from '../erroresConsulta';

// Códigos de actividad económica del SII, desde la página pública que los
// publica entera: https://www.sii.cl/ayudas/ayudas_por_servicios/1956-codigos-1959.html
//
// Es HTML estático: una sola tabla con ~930 filas donde conviven tres clases de
// fila —el rubro (una celda, en mayúsculas), la cabecera de cada subrubro
// ("Código", nombre del subrubro, "Afecto a IVA", "Categoría Tributaria",
// "Disponible Internet") y los códigos—. Se distinguen por FORMA, no por
// posición: el rubro es la fila de una celda, la cabecera empieza con "Código",
// y el código es la fila cuya primera celda son seis dígitos.
//
// Sin credencial. El SII cuenta las requests igual, así que se anuncia como
// navegador y el resultado se cachea en el core.
const URL = 'https://www.sii.cl/ayudas/ayudas_por_servicios/1956-codigos-1959.html';
const TIMEOUT_MS = 30_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LIMITE_DE_CONSULTAS = /Error\s*429|superado el l[ií]mite/i;

export interface ActividadEconomica {
  codigo: string;
  descripcion: string;
  rubro: string;
  subrubro: string;
  afectaIva: boolean;
  // Tal como la publica el SII: "1" (primera categoría), "2" (segunda) o "G"
  // (el código 091002, por ejemplo, viene con "G"). No se traduce a número
  // porque el SII usa letras para casos que su propia tabla no explica, y
  // convertirlas sería inventar. apigateway filtra por 1 y 2; acá se puede
  // filtrar por cualquiera de los valores que la tabla traiga.
  categoriaTributaria: string;
  disponibleInternet: boolean;
}

const ENTIDADES: Record<string, string> = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  nbsp: ' ', amp: '&', quot: '"', uuml: 'ü', Uuml: 'Ü',
};

function limpiar(html: string): string {
  return html.replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z]+);/g, (m, e) => ENTIDADES[e] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

function celdas(fila: string): string[] {
  return [...fila.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => limpiar(m[1]));
}

export function parsearActividades(html: string): ActividadEconomica[] {
  // La tabla que trae la cabecera de los códigos, no la PRIMERA de la página:
  // una tabla de layout agregada antes convertiría los datos en "ningún código".
  const tabla = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => m[0])
    .find(t => /Categor/i.test(t) && /C[oó]digo|C&oacute;digo/i.test(t));
  if (!tabla) {
    throw new Error(
      'La página de códigos de actividad económica del SII no trae la tabla esperada. '
      + 'Cambió el formato y hay que revisar el parseo.');
  }

  const salida: ActividadEconomica[] = [];
  let rubro = '';
  let subrubro = '';
  for (const fila of tabla.split(/<tr[^>]*>/i).slice(1)) {
    const c = celdas(fila);
    if (c.length === 0) continue;
    if (c.length === 1) { rubro = c[0]; continue; }
    if (/^c[oó]digo$/i.test(c[0])) { subrubro = c[1] ?? ''; continue; }
    if (!/^\d{6}$/.test(c[0]) || c.length < 5) continue;

    // Una categoría vacía sí es un cambio de formato: la columna siempre trae algo.
    if (c[3] === '') {
      throw new Error(`El código ${c[0]} viene sin categoría tributaria: cambió el formato de la tabla.`);
    }
    salida.push({
      codigo: c[0],
      descripcion: c[1],
      rubro,
      subrubro,
      afectaIva: /^s[ií]$/i.test(c[2]),
      categoriaTributaria: c[3],
      disponibleInternet: /^s[ií]$/i.test(c[4]),
    });
  }

  // Una tabla con la forma esperada pero sin códigos es un cambio de formato: la
  // lista real tiene cientos.
  if (salida.length === 0) {
    throw new Error('La tabla de actividades económicas no trajo ningún código reconocible.');
  }
  return salida;
}

export async function actividades(): Promise<ActividadEconomica[]> {
  let resp: Response;
  try {
    resp = await fetch(URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es-CL,es;q=0.9' },
    });
  } catch (e) {
    throw new Error(`No se pudo bajar la página de actividades económicas del SII: ${(e as Error).message}`);
  }
  if (!resp.ok) throw new Error(`El SII respondió ${resp.status} al pedir los códigos de actividad económica.`);
  // Latin1 como todo el SII.
  const html = Buffer.from(await resp.arrayBuffer()).toString('latin1');
  if (LIMITE_DE_CONSULTAS.test(html.slice(0, 4000)) && /<html/i.test(html.slice(0, 500))) {
    throw new LimiteDeConsultasSii(
      'El SII cortó las consultas por volumen (su error 429). Hay que ESPERAR: '
      + 'reintentar de inmediato mantiene el corte. Ver ritmoSii.ts.');
  }
  return parsearActividades(html);
}
