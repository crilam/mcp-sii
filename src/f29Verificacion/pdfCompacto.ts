import { inflateSync } from 'zlib';

// Lectura del PDF del formulario compacto del F29 (el que entrega
// `core/f29.compacto`). Sin dependencias: el SII lo genera con Helvetica y
// WinAnsiEncoding, sin fuentes incrustadas ni CMaps, así que el texto está en
// literales `(...)` de los operadores Tj/TJ dentro de streams FlateDecode. Un
// lector general de PDF (pdfjs) es ESM y pesado para leer eso.
//
// Cada objeto de texto (BT … ET) es una celda del formulario, y el SII las
// escribe en orden de lectura: código, glosa, valor. Si un día el SII cambia el
// generador y esto deja de calzar, `leerCompacto` falla con un error explícito
// en vez de devolver casilleros vacíos: un F29 sin casilleros se leería como
// "todo en cero", que es justo el error que esta verificación busca.

export interface F29Declarado {
  folio: number | null;
  periodo: number | null;
  rut: string | null;
  /** Primitiva o Rectificatoria, tal como lo imprime el SII. */
  tipoDeclaracion: string | null;
  /** dd/mm/aaaa, tal como lo imprime el SII. */
  fechaPresentacion: string | null;
  /** Código de tres o cuatro dígitos (con ceros a la izquierda) → valor. */
  codigos: Record<string, number>;
  /** Glosa impresa junto a cada código, para el reporte. */
  glosas: Record<string, string>;
}

export class PdfF29Ilegible extends Error {}

/** Celdas de texto del PDF, en el orden en que aparecen en los streams. */
export function textosDelPdf(pdf: Buffer): string[] {
  const textos: string[] = [];
  let desde = 0;
  for (;;) {
    const i = pdf.indexOf('stream', desde, 'latin1');
    if (i === -1) break;
    // `endstream` también contiene "stream": se salta.
    if (pdf.subarray(i - 3, i).toString('latin1') === 'end') { desde = i + 6; continue; }
    let inicio = i + 6;
    if (pdf[inicio] === 0x0d) inicio++;
    if (pdf[inicio] === 0x0a) inicio++;
    const fin = pdf.indexOf('endstream', inicio, 'latin1');
    if (fin === -1) break;
    desde = fin + 9;
    const dic = pdf.subarray(Math.max(0, i - 300), i).toString('latin1');
    const inicioDic = dic.lastIndexOf('<<');
    if (!/\/FlateDecode/.test(dic.slice(inicioDic)) || /\/Subtype\s*\/Image/.test(dic.slice(inicioDic))) continue;
    let contenido: string;
    try {
      contenido = inflateSync(pdf.subarray(inicio, fin), { finishFlush: 2 /* Z_SYNC_FLUSH */ }).toString('latin1');
    } catch {
      continue;
    }
    if (!contenido.includes('BT')) continue;
    textos.push(...celdasDeTexto(contenido));
  }
  return textos;
}

// Une los literales de cada bloque BT … ET. Sólo interesan los strings: la
// posición no hace falta porque el orden del stream ya es el de lectura.
function celdasDeTexto(contenido: string): string[] {
  const celdas: string[] = [];
  const bloque = /\bBT\b([\s\S]*?)\bET\b/g;
  let m: RegExpExecArray | null;
  while ((m = bloque.exec(contenido))) {
    const partes = literales(m[1]);
    const texto = partes.join('').replace(/\s+/g, ' ').trim();
    if (texto) celdas.push(texto);
  }
  return celdas;
}

function literales(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '(') continue;
    let prof = 1;
    let buf = '';
    i++;
    for (; i < s.length && prof > 0; i++) {
      const c = s[i];
      if (c === '\\') {
        const n = s[++i];
        if (/[0-7]/.test(n)) {
          let oct = n;
          while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
          buf += String.fromCharCode(parseInt(oct, 8));
        } else {
          buf += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[n] ?? n;
        }
      } else if (c === '(') { prof++; buf += c; }
      else if (c === ')') { prof--; if (prof > 0) buf += c; }
      else buf += c;
    }
    i--;
    out.push(buf);
  }
  return out;
}

const CODIGO = /^\d{2,4}$/;
const MONTO = /^-?(\d{1,3}(\.\d{3})+|\d+)$/;
const DECIMAL = /^-?\d+[.,]\d{1,2}$/;
const FECHA = /^\d{2}\/\d{2}\/\d{4}$/;

/** Número del formulario: miles con punto; un decimal corto (tasa PPM) se respeta. */
export function numeroF29(texto: string): number | null {
  const t = texto.trim();
  if (MONTO.test(t)) return Number(t.replace(/\./g, ''));
  if (DECIMAL.test(t)) return Number(t.replace(',', '.'));
  return null;
}

/** Lee folio, período, tipo, fecha y los casilleros con valor del PDF compacto. */
export function leerCompacto(pdf: Buffer): F29Declarado {
  const t = textosDelPdf(pdf);
  const codigos: Record<string, number> = {};
  const glosas: Record<string, string> = {};

  // Los casilleros van como tríos código-glosa-valor después del encabezado
  // "Código / Glosa / Valor". Un código sin valor (931, 932…) se salta: lo que
  // sigue a su glosa es otro código.
  const tabla = t.indexOf('Código');
  if (tabla === -1) throw new PdfF29Ilegible('El PDF no trae la tabla "Código / Glosa / Valor": no parece un F29 compacto o cambió el formato.');
  for (let i = tabla; i + 2 < t.length; i++) {
    if (!CODIGO.test(t[i]) || !/[A-Za-zÁÉÍÓÚÑ]/.test(t[i + 1]) || t[i + 1] === 'Código') continue;
    const valor = numeroF29(t[i + 2]);
    if (valor === null) continue;
    // Si lo que sigue a la glosa es OTRO trío (código seguido de glosa), el
    // casillero vino sin valor.
    if (CODIGO.test(t[i + 2]) && /[A-Za-zÁÉÍÓÚÑ]/.test(t[i + 3] ?? '')) continue;
    if (!(t[i] in codigos)) {
      codigos[t[i]] = valor;
      glosas[t[i]] = t[i + 1];
    }
    i += 2;
  }
  if (Object.keys(codigos).length === 0) {
    throw new PdfF29Ilegible('No se pudo leer ningún casillero del PDF del F29: cambió el formato.');
  }

  const despues = (etiqueta: RegExp, patron: RegExp): string | null => {
    const k = t.findIndex(x => etiqueta.test(x));
    if (k === -1) return null;
    return t.slice(k + 1).find(x => patron.test(x)) ?? null;
  };
  const folio = despues(/^FOLIO$/, /^\d{6,}$/);
  const periodo = despues(/^PERIODO$/, /^\d{6}$/);
  const rut = t.map(x => /^\[03\]\s*([\d.]+-[\dkK])$/.exec(x)?.[1]).find(Boolean) ?? despues(/^RUT$/, /^[\d.]+-[\dkK]$/);
  const tipo = t.find(x => /^(Primitiva|Rectificatoria|Rectificatoria Giro|Original)$/i.test(x)) ?? null;
  const fecha = despues(/^Fecha de Presentaci/, FECHA);

  return {
    folio: folio ? Number(folio) : null,
    periodo: periodo ? Number(periodo) : null,
    rut: rut ? rut.replace(/\./g, '') : null,
    tipoDeclaracion: tipo,
    fechaPresentacion: fecha,
    codigos,
    glosas,
  };
}
