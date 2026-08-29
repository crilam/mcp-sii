import ExcelJS from 'exceljs';
import { LimiteDeConsultasSii, RecursoNoEncontrado } from '../erroresConsulta';

// Tasación fiscal de vehículos, desde las planillas anuales que el SII publica.
//
// La consulta interactiva del portal (`www4.sii.cl/vehiculospubui`) exige un
// captcha propio del SII antes de cualquier búsqueda, así que no es un camino
// que un servicio pueda recorrer solo. Pero el mismo dato —código SII, marca,
// modelo, versión, año, tasación y valor del permiso— el SII lo publica entero
// en un XLSX por año y categoría, público, sin sesión ni captcha:
//   https://www.sii.cl/servicios_online/tasacion_fiscal_vehiculos/liv2026.xlsx
//   https://www.sii.cl/servicios_online/tasacion_fiscal_vehiculos/pes2026.xlsx
// Es la fuente de esta implementación. Una planilla son ~7 MB y ~80.000 filas;
// se baja UNA vez por año y categoría y de ahí en más se consulta en memoria.
//
// Es el segundo dominio público del repo después de indicadores, y hereda sus
// reglas: el SII cuenta las requests igual aunque no haya credencial, así que
// se anuncia como navegador y el caché es parte del contrato, no una
// optimización.
const BASE = 'https://www.sii.cl/servicios_online/tasacion_fiscal_vehiculos';
const TIMEOUT_MS = 90_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LIMITE_DE_CONSULTAS = /Error\s*429|superado el l[ií]mite/i;

export type CategoriaVehiculo = 'liviano' | 'pesado';

// Una fila de la planilla, con los nombres del SII traducidos a camelCase. La
// tasación y el permiso son del AÑO de la planilla, no del año de fabricación.
export interface TasacionVehiculo {
  codigoSii: string;
  anioFabricacion: number;
  tipo: string;
  marca: string;
  modelo: string;
  version: string;
  puertas: number | null;
  cilindrada: number | null;
  potencia: number | null;
  combustible: string;
  transmision: string;
  marchas: number | null;
  traccion: string;
  pais: string;
  equipamiento: string;
  // Sólo en pesados: la planilla de livianos no trae carga ni pasajeros, y la
  // de pesados no trae puertas, potencia, combustible ni permiso. Lo que una
  // categoría no informa va en null, no en cero: un camión con "0 kg de carga"
  // sería un dato, y acá lo que hay es ausencia.
  carga: number | null;
  pasajeros: number | null;
  tasacion: number;
  // El valor del permiso de circulación sólo viene en la planilla de livianos.
  permiso: number | null;
  observacion: string;
}

export interface Equipamiento {
  sigla: string;
  descripcion: string;
}

export interface PlanillaTasacion {
  anio: number;
  categoria: CategoriaVehiculo;
  filas: TasacionVehiculo[];
  equipamiento: Equipamiento[];
}

// Las columnas se ubican por NOMBRE de cabecera y nunca por posición: la fila
// de cabecera está en la 12 en las planillas de 2026, pero el preámbulo (SII,
// subdirección, notas) puede cambiar de largo entre años. Y una columna nueva
// en el medio no debe correr todas las demás en silencio.
const COLUMNAS: Record<string, keyof TasacionVehiculo> = {
  'codigo sii': 'codigoSii',
  'ano': 'anioFabricacion',
  'tipo': 'tipo',
  'marca': 'marca',
  'modelo': 'modelo',
  'version': 'version',
  'puertas': 'puertas',
  'cilindrada (cc)': 'cilindrada',
  'potencia (hp)': 'potencia',
  'combustible': 'combustible',
  'transmision': 'transmision',
  'marchas': 'marchas',
  'traccion': 'traccion',
  'pais': 'pais',
  'equipamiento': 'equipamiento',
  'carga (kg)': 'carga',
  'pasajeros (cantidad)': 'pasajeros',
  // "Tasación 2026" / "Permiso 2026": se normalizan quitando el año.
  'tasacion': 'tasacion',
  'permiso': 'permiso',
  'observacion': 'observacion',
};

function normalizarCabecera(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+\d{4}$/, '')          // "tasacion 2026" → "tasacion"
    .replace(/\s+\d+(\.\d+)*$/, '')    // "observacion 21.420" → "observacion"
    .replace(/\s*\(cantidad\)\s*$/, ' (cantidad)') // "Pasajeros (cantidad)" con o sin espacio
    .replace(/\s+/g, ' ')
    .trim();
}

function texto(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in (v as object)) {
    return (v as ExcelJS.CellRichTextValue).richText.map(r => r.text).join('').trim();
  }
  if (typeof v === 'object' && 'result' in (v as object)) {
    return texto((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
  }
  return String(v).trim();
}

function entero(v: ExcelJS.CellValue): number | null {
  const t = texto(v).replace(/\./g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parsea el libro entero. Exportado para testear con una planilla chica.
 *
 * Falla explícito si no encuentra la fila de cabecera con las columnas
 * mínimas: una planilla que cambió de formato no puede convertirse en "cero
 * vehículos", que se lee como un año sin datos.
 */
export async function parsearPlanilla(
  contenido: Buffer, anio: number, categoria: CategoriaVehiculo
): Promise<PlanillaTasacion> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(contenido as unknown as ExcelJS.Buffer);

  const hoja = wb.worksheets[0];
  if (!hoja) throw new Error('La planilla de tasación no tiene hojas.');

  // Ubicar la cabecera: la primera fila que tenga "Código SII" y "Marca".
  let filaCabecera = 0;
  const indice = new Map<keyof TasacionVehiculo, number>();
  hoja.eachRow((fila, n) => {
    if (filaCabecera !== 0) return;
    const nombres = new Map<string, number>();
    fila.eachCell((celda, col) => nombres.set(normalizarCabecera(texto(celda.value)), col));
    if (nombres.has('codigo sii') && nombres.has('marca')) {
      filaCabecera = n;
      for (const [nombre, col] of nombres) {
        const campo = COLUMNAS[nombre];
        if (campo) indice.set(campo, col);
      }
    }
  });
  // `permiso` no es obligatoria: pesados no la trae.
  const obligatorias: (keyof TasacionVehiculo)[] = ['codigoSii', 'anioFabricacion', 'marca', 'modelo', 'tasacion'];
  const faltantes = obligatorias.filter(c => !indice.has(c));
  if (filaCabecera === 0 || faltantes.length > 0) {
    throw new Error(
      `La planilla de tasación ${categoria} ${anio} no tiene la cabecera esperada`
      + (faltantes.length ? ` (faltan: ${faltantes.join(', ')})` : '')
      + '. El SII cambió el formato y hay que revisar el parseo.');
  }

  const filas: TasacionVehiculo[] = [];
  const celda = (fila: ExcelJS.Row, campo: keyof TasacionVehiculo): ExcelJS.CellValue => {
    const col = indice.get(campo);
    return col === undefined ? null : fila.getCell(col).value;
  };
  hoja.eachRow((fila, n) => {
    if (n <= filaCabecera) return;
    const codigo = texto(celda(fila, 'codigoSii'));
    const tasacion = entero(celda(fila, 'tasacion'));
    // Filas de notas al pie o vacías: sin código o sin tasación no son vehículos.
    if (codigo === '' || tasacion === null) return;
    filas.push({
      codigoSii: codigo,
      anioFabricacion: entero(celda(fila, 'anioFabricacion')) ?? 0,
      tipo: texto(celda(fila, 'tipo')),
      marca: texto(celda(fila, 'marca')),
      modelo: texto(celda(fila, 'modelo')),
      version: texto(celda(fila, 'version')),
      puertas: entero(celda(fila, 'puertas')),
      cilindrada: entero(celda(fila, 'cilindrada')),
      potencia: entero(celda(fila, 'potencia')),
      combustible: texto(celda(fila, 'combustible')),
      transmision: texto(celda(fila, 'transmision')),
      marchas: entero(celda(fila, 'marchas')),
      traccion: texto(celda(fila, 'traccion')),
      pais: texto(celda(fila, 'pais')),
      equipamiento: texto(celda(fila, 'equipamiento')),
      carga: entero(celda(fila, 'carga')),
      pasajeros: entero(celda(fila, 'pasajeros')),
      tasacion,
      permiso: indice.has('permiso') ? entero(celda(fila, 'permiso')) : null,
      observacion: texto(celda(fila, 'observacion')),
    });
  });

  // La segunda hoja es el diccionario de siglas de equipamiento ("AA" → "Aire
  // Acondicionado"). Sin ella, el campo `equipamiento` es una lista de siglas
  // que nadie puede leer.
  const equipamiento: Equipamiento[] = [];
  const hojaEq = wb.worksheets[1];
  if (hojaEq) {
    let enDatos = false;
    hojaEq.eachRow(fila => {
      const a = texto(fila.getCell(1).value);
      const b = texto(fila.getCell(2).value);
      if (normalizarCabecera(a) === 'siglas') { enDatos = true; return; }
      if (enDatos && a !== '' && b !== '') equipamiento.push({ sigla: a, descripcion: b });
    });
  }

  return { anio, categoria, filas, equipamiento };
}

async function bajar(ruta: string): Promise<Buffer> {
  let resp: Response;
  try {
    resp = await fetch(`${BASE}/${ruta}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es-CL,es;q=0.9' },
    });
  } catch (e) {
    throw new Error(`No se pudo bajar la planilla de tasación ${ruta} del SII: ${(e as Error).message}`);
  }
  if (resp.status === 404) {
    throw new RecursoNoEncontrado(
      `El SII no publica la planilla de tasación ${ruta}. Las planillas anuales existen desde 2020 `
      + 'en XLSX; los años anteriores vienen en otro formato (ZIP) y no están cubiertos.');
  }
  if (!resp.ok) throw new Error(`El SII respondió ${resp.status} al pedir ${ruta}.`);

  const contenido = Buffer.from(await resp.arrayBuffer());
  // El corte por volumen llega como una página HTML, nunca como un XLSX válido.
  const tipo = resp.headers.get('content-type') ?? '';
  if (/text\/html/i.test(tipo)) {
    const inicio = contenido.subarray(0, 4000).toString('latin1');
    if (LIMITE_DE_CONSULTAS.test(inicio)) {
      throw new LimiteDeConsultasSii(
        'El SII cortó las consultas por volumen (su error 429). Hay que ESPERAR: '
        + 'reintentar de inmediato mantiene el corte. Ver ritmoSii.ts.');
    }
    throw new Error(`El SII devolvió HTML en vez de la planilla ${ruta}: ${inicio.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return contenido;
}

export function nombrePlanilla(anio: number, categoria: CategoriaVehiculo): string {
  return `${categoria === 'liviano' ? 'liv' : 'pes'}${anio}.xlsx`;
}

export async function planilla(anio: number, categoria: CategoriaVehiculo): Promise<PlanillaTasacion> {
  return parsearPlanilla(await bajar(nombrePlanilla(anio, categoria)), anio, categoria);
}
