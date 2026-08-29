import { MisiiScraper, FichaCruda, AtributoMisii } from '../scrapers/misii';
import { LimitacionConocida } from '../erroresConsulta';
import { partirRut } from '../rut';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

// Versión del parseo, que viaja en cada respuesta. El consumidor la guarda con
// la captura para poder auditar hacia atrás un dato que después resultó estar
// mal: sin ella, una ficha guardada hace tres meses no dice con qué reglas se
// construyó.
export const PARSER_VERSION = 1;

// El régimen es el atributo cuyo código empieza con `14` (el artículo de la Ley
// de la Renta). Relevado: `14D1` = "REGIMEN PRO PYME GENERAL (14D)".
//
// NO se mapea el código a un enum propio acá: sólo se relevó uno, y se sabe que
// existe al menos otro (`14D3`, que una de las empresas relevadas tuvo antes)
// que nadie pudo capturar. Inventar el mapeo del resto sería exactamente el
// error que este repositorio viene evitando. Se entrega el código y la glosa
// tal como los da el SII, y quien clasifique decide con evidencia.
const PREFIJO_REGIMEN = /^14/;

export interface RegimenFicha {
  codigo: string;
  descripcion: string;
  desde: string | null;
  hasta: string | null;
}

export interface FichaContribuyente {
  /** Cuándo se leyó DEL SII. Ver la nota de `capturadoEn` más abajo. */
  capturadoEn: string;
  parserVersion: number;
  /** RUT según el payload del SII, no según el request. */
  rut: string;
  razonSocial: string | null;
  tipoContribuyente: { codigo: string | null; descripcion: string | null };
  subtipoContribuyente: { codigo: string | null; descripcion: string | null };
  fechaConstitucion: string | null;
  fechaInicioActividades: string | null;
  fechaTerminoGiro: string | null;
  segmento: { codigo: string | null; descripcion: string | null };
  regimen: RegimenFicha | null;
  actividades: {
    /** Código ACTECO. STRING y no número: varios empiezan con cero. */
    codigo: string | null;
    giro: string | null;
    categoria: number | null;
    afectaIva: boolean | null;
    desde: string | null;
  }[];
  direcciones: {
    /** Código de sucursal que asigna el SII. Es lo que distingue una de otra. */
    codigo: string | null;
    tipo: string | null;
    calle: string | null;
    numero: string | null;
    comuna: { codigo: string | null; descripcion: string | null };
    region: { codigo: string | null; descripcion: string | null };
  }[];
  atributos: {
    codigo: string;
    descripcion: string;
    desde: string | null;
    hasta: string | null;
    valor: string | null;
  }[];
  crudo: FichaCruda & { version: number };
}

// El SII usa DOS formatos de fecha en el mismo payload: "2008-05-26 00:00:00.0"
// en `contribuyente` y "01-01-2026" (dd-mm-aaaa) en `atributos`. Se normalizan
// acá y no en cada consumidor: la irregularidad es del SII, es conocida, y
// replicar la conversión en cada cliente multiplica el mismo bug. El payload
// original queda intacto bajo `crudo` para quien necesite auditar.
export function aIso(fecha: string | null | undefined): string | null {
  if (!fecha) return null;
  const conHora = /^(\d{4})-(\d{2})-(\d{2})[ T]/.exec(fecha);
  if (conHora) return `${conHora[1]}-${conHora[2]}-${conHora[3]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  const ddmmaaaa = /^(\d{2})-(\d{2})-(\d{4})$/.exec(fecha);
  if (ddmmaaaa) return `${ddmmaaaa[3]}-${ddmmaaaa[2]}-${ddmmaaaa[1]}`;
  // Un formato que no se reconoce se devuelve tal cual y NO como null: null
  // diría "el SII no informó esta fecha", que es distinto de "el SII la informó
  // y no supimos leerla". El consumidor ve el string raro y puede reclamar.
  return fecha;
}

// Los booleanos del SII son strings: "S"/"N" en los campos de actividad,
// "No"/"Si" en otros. Cualquier otra cosa es null, no `false`: un `false`
// inventado afirma que el SII dijo que no.
export function aBooleano(valor: string | null | undefined): boolean | null {
  if (valor === null || valor === undefined) return null;
  const v = valor.trim().toUpperCase();
  if (v === 'S' || v === 'SI' || v === 'SÍ') return true;
  if (v === 'N' || v === 'NO') return false;
  return null;
}

function aNumero(valor: string | null | undefined): number | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

// El régimen VIGENTE, que es lo único que este portal publica: el payload no
// guarda el anterior. Verificado con un caso real — una empresa que cambió de
// régimen con vigencia 01-01-2026 no deja rastro del que tenía antes.
//
// Por eso `desde` no es decorativo: es el único dato con el que el consumidor
// puede saber para qué períodos vale esta respuesta. Un F29 de un período
// anterior a esa fecha NO se calcula con este régimen.
export function regimenDe(atributos: AtributoMisii[], hoy = new Date()): RegimenFicha | null {
  // Vigente es "sin término" O "con término todavía por venir". Descartar
  // cualquier `fechaTermino` dejaba `regimen: null` —que el contrato define como
  // "no se pudo determinar"— para un régimen que el SII informa perfectamente,
  // sólo porque tiene fecha de fin agendada.
  const vigentes = atributos.filter(a => {
    if (!PREFIJO_REGIMEN.test(String(a.atrCodigo ?? ''))) return false;
    if (!a.fechaTermino) return true;
    const termino = aIso(a.fechaTermino);
    return termino !== null && termino >= hoy.toISOString().slice(0, 10);
  });

  // Dos regímenes vigentes a la vez no debería pasar, y justamente por eso no
  // se puede resolver eligiendo el primero: el orden del array no es un
  // criterio, y de este campo sale el F29 del consumidor. Se falla con los dos
  // códigos a la vista, que es lo que necesita quien tenga que decidir.
  if (vigentes.length > 1) {
    throw new LimitacionConocida(
      `El SII informa ${vigentes.length} regímenes vigentes a la vez ` +
      `(${vigentes.map(v => v.atrCodigo).join(', ')}): no se puede determinar cuál rige.`
    );
  }

  const a = vigentes[0];
  if (!a) return null;
  return {
    codigo: String(a.atrCodigo),
    descripcion: String(a.descAtrCodigo ?? ''),
    desde: aIso(a.fechaInicio),
    hasta: aIso(a.fechaTermino),
  };
}

export function normalizar(cruda: FichaCruda, capturadoEn: string): FichaContribuyente {
  const c = cruda.contribuyente;
  return {
    capturadoEn,
    parserVersion: PARSER_VERSION,
    rut: `${c.rut}-${c.dv}`,
    razonSocial: c.razonSocial ?? null,
    tipoContribuyente: {
      codigo: c.tipoContribuyenteCodigo ?? null,
      descripcion: c.tipoContribuyenteDescripcion ?? null,
    },
    subtipoContribuyente: {
      codigo: c.subtipoContribuyenteCodigo ?? null,
      descripcion: c.subtipoContribuyenteDescrip ?? null,
    },
    fechaConstitucion: aIso(c.fechaConstitucion),
    fechaInicioActividades: aIso(c.fechaInicioActividades),
    fechaTerminoGiro: aIso(c.fechaTerminoGiro),
    segmento: {
      codigo: c.segmentoCodigo ?? null,
      descripcion: c.segmentoDescripcion ?? null,
    },
    regimen: regimenDe(cruda.atributos),
    // Cada elemento de `DatosActeco` trae su propio `codigoError`: un
    // contribuyente sin actividades devuelve un elemento de error con todo en
    // null, que sin filtrar pasaba como una actividad fantasma y el consumidor
    // la mostraría como una actividad real.
    actividades: cruda.actividades.filter(a => a.codigo).map(a => ({
      // El código ACTECO se deja como STRING. Convertirlo a número se come el
      // cero a la izquierda —011101 (cultivo de trigo) quedaría en 11101—, y
      // ese código no existe: el join contra la tabla de actividades del SII
      // no encuentra nada, o peor, encuentra otra actividad.
      codigo: a.codigo ?? null,
      giro: a.descripcion ?? null,
      categoria: aNumero(a.categoriaTributaria),
      afectaIva: aBooleano(a.afectoIva),
      desde: aIso(a.fechaInicio),
    })),
    // Se expone el `codigo` de cada dirección y los códigos de comuna y región,
    // no sólo sus descripciones: el código es lo que distingue una sucursal de
    // otra —y el comportamiento con varias direcciones es justamente lo que no
    // se pudo verificar—, y las descripciones no sirven para cruzar contra
    // tablas oficiales de comuna.
    direcciones: cruda.direcciones.map(d => ({
      codigo: d.codigo ?? null,
      tipo: d.tipoDomicilioDescripcion ?? null,
      calle: d.calle ?? null,
      numero: d.numero ?? null,
      comuna: { codigo: d.comunaCodigo ?? null, descripcion: d.comunaDescripcion ?? null },
      region: { codigo: d.regionCodigo ?? null, descripcion: d.regionDescripcion ?? null },
    })),
    // Un atributo sin código se descarta en vez de emitirse como la cadena
    // "undefined": un código inventado es peor que un atributo de menos, porque
    // el consumidor lo trata como un dato del SII.
    atributos: cruda.atributos.filter(a => a.atrCodigo).map(a => ({
      codigo: String(a.atrCodigo),
      descripcion: String(a.descAtrCodigo ?? ''),
      desde: aIso(a.fechaInicio),
      hasta: aIso(a.fechaTermino),
      valor: a.valor ?? null,
    })),
    crudo: { ...cruda, version: PARSER_VERSION },
  };
}

export async function fichaContribuyente(
  registro: EjecutorSesion<SessionManager>,
  rut: string
): Promise<FichaContribuyente> {
  return registro.ejecutar(rut, async sesion => {
    const scraper = new MisiiScraper(new SiiHttpClient(sesion));
    const cruda = await scraper.ficha();

    // La ficha es de la IDENTIDAD AUTENTICADA, no del RUT que viaja en el
    // request. Hoy son el mismo —la credencial es la de ese RUT—, pero si
    // alguna vez difieren, el consumidor persistiría contra el RUT que pidió
    // una ficha que es de otro contribuyente, sin ninguna señal de que pasó.
    // Es el peor error que puede cometer este endpoint, y cuesta una
    // comparación: se corta acá en vez de confiar en que no ocurra.
    const pedido = partirRut(rut, 'RUT del request');
    const devuelto = `${cruda.contribuyente.rut}-${cruda.contribuyente.dv}`;
    if (devuelto !== `${pedido.rut}-${pedido.dv}`) {
      throw new LimitacionConocida(
        `El SII devolvió la ficha de ${devuelto} y se pidió la de ` +
        `${pedido.rut}-${pedido.dv}: no se entrega una identidad que no es la pedida.`
      );
    }
    // `capturadoEn` se sella cuando LLEGA el dato del SII, no cuando se
    // responde. Hoy son casi lo mismo; en cuanto haya caché dejan de serlo, y
    // fechar con la hora de la respuesta afirmaría una confirmación contra el
    // SII que no ocurrió — justo la fecha que el consumidor le muestra al
    // usuario en la ficha.
    return normalizar(cruda, new Date().toISOString());
  });
}
