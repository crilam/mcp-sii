import * as f29 from '../core/f29';
import * as rcv from '../core/rcv';
import * as misii from '../core/misii';
import { RecursoNoEncontrado } from '../erroresConsulta';
import { EjecutorSesion } from '../registroSesiones';
import { SessionManager } from '../session';
import { ResumenRcv } from '../scrapers/rcv';
import { leerCompacto, F29Declarado } from './pdfCompacto';
import { verificar, ResultadoVerificacion, Efectos } from './reglas';
import { periodoVencido, vencimiento, estadoPlazo, anteriorPeriodo, siguientePeriodo, fechaIso, EstadoPlazo } from './plazos';

// La única parte de la verificación que habla con el SII. SÓLO LECTURA: usa
// estado y compacto del F29, propuesta, resumen y detalle del RCV y la ficha de
// Mi SII. Un test fija esta lista de imports para que nadie agregue una
// escritura (emitir, acusar, borradores) por accidente.
//
// No cierra la sesión: la tool MCP la reutiliza y el CLI la cierra al final.

export interface OpcionesVerificacion {
  rut: string;
  /** Períodos a revisar contra el RCV. Vacío: el último declarado. */
  periodos?: number[];
  /** Además, la propuesta vigente del SII para este período (antes de declarar). */
  propuesta?: number | null;
  hoy?: Date;
  /** Día de vencimiento. Sin él, el de la ficha (20 si está autorizado, 12 si no). */
  diaVencimiento?: 12 | 20;
  feriados?: string[];
}

export interface Declaracion {
  periodo: number;
  vence: string;
  estado: EstadoPlazo;
  folio: number | null;
  fechaPresentacion: string | null;
  tipoDeclaracion: string | null;
}

export interface VerificacionPeriodo extends ResultadoVerificacion {
  folio: number | null;
  fechaPresentacion: string | null;
  tipoDeclaracion: string | null;
}

export interface ReporteF29 {
  rut: string;
  generadoEn: string;
  diaVencimiento: 12 | 20;
  diaVencimientoOrigen: string;
  declaracion: Declaracion;
  verificaciones: VerificacionPeriodo[];
  totales: Efectos;
  avisos: string[];
}

type Ejecutor = EjecutorSesion<SessionManager>;

export async function verificarF29(ejecutor: Ejecutor, o: OpcionesVerificacion): Promise<ReporteF29> {
  const hoy = o.hoy ?? new Date();
  const avisos: string[] = [];
  const ficha = await misii.datosContribuyente(ejecutor, o.rut).catch(e => {
    avisos.push(`No se pudo leer la ficha de Mi SII (${(e as Error).message}): sin actividades para decidir la condición IVA en meses sin ventas.`);
    return null;
  });
  const dia: 12 | 20 = o.diaVencimiento ?? (ficha?.autorizadoDeclararDia20 === false ? 12 : 20);
  const diaOrigen = o.diaVencimiento ? 'indicado por parámetro'
    : ficha ? `ficha de Mi SII (autorizado a declarar el día 20: ${ficha.autorizadoDeclararDia20 ? 'sí' : 'no'})`
      : 'por defecto (sin ficha de Mi SII)';

  // Cache por período: un rango comparte los RCV de los meses vecinos.
  const resumenes = new Map<string, Promise<ResumenRcv>>();
  const resumen = (p: number, op: 'COMPRA' | 'VENTA') => {
    const k = `${p}_${op}`;
    if (!resumenes.has(k)) resumenes.set(k, rcv.resumen(ejecutor, o.rut, String(p), op));
    return resumenes.get(k)!;
  };
  const compactos = new Map<number, Promise<F29Declarado | null>>();
  const compacto = (p: number) => {
    if (!compactos.has(p)) {
      compactos.set(p, f29.compacto(ejecutor, o.rut, p)
        .then(c => leerCompacto(c.pdf))
        .catch(e => { if (e instanceof RecursoNoEncontrado) return null; throw e; }));
    }
    return compactos.get(p)!;
  };

  // A. ¿Está declarado el último período vencido?
  const vencido = periodoVencido(hoy);
  const vence = vencimiento(vencido, dia, o.feriados);
  const declVencido = await compacto(vencido);
  const declaracion: Declaracion = {
    periodo: vencido, vence: fechaIso(vence), estado: estadoPlazo(declVencido, vence, hoy),
    folio: declVencido?.folio ?? null, fechaPresentacion: declVencido?.fechaPresentacion ?? null,
    tipoDeclaracion: declVencido?.tipoDeclaracion ?? null,
  };

  // C. Qué períodos se cruzan con el RCV. Sin indicación: el último declarado,
  // buscando hacia atrás hasta tres meses.
  let periodos = o.periodos ?? [];
  if (periodos.length === 0) {
    let p = vencido;
    for (let i = 0; i < 3; i++, p = anteriorPeriodo(p)) {
      if (await compacto(p)) { periodos = [p]; break; }
    }
    if (periodos.length === 0) avisos.push(`No hay F29 vigente entre ${anteriorPeriodo(anteriorPeriodo(vencido))} y ${vencido}.`);
  }

  const verificaciones: VerificacionPeriodo[] = [];
  const cruzar = async (p: number, casilleros: Record<string, number>, fuente: 'F29' | 'propuesta', decl: F29Declarado | null) => {
    const [compras, ventas] = [await resumen(p, 'COMPRA'), await resumen(p, 'VENTA')];
    const hayNc = compras.filas.some(f => f.tipoDocCodigo === 61 && f.documentos > 0);
    const nc = hayNc ? (await rcv.detalle(ejecutor, o.rut, String(p), 'COMPRA', 61)).documentos : [];
    const anteriores: ResumenRcv[] = [];
    for (let q = anteriorPeriodo(p), i = 0; i < 6; q = anteriorPeriodo(q), i++) {
      anteriores.unshift(await resumen(q, 'VENTA'));
    }
    const r = verificar({
      periodo: p, fuente, casilleros, compras, ventas, ncCompras: nc,
      ventasAnteriores: anteriores.filter(x => !x.sinDatos), actividades: ficha?.actividades,
    });
    verificaciones.push({ ...r, folio: decl?.folio ?? null, fechaPresentacion: decl?.fechaPresentacion ?? null, tipoDeclaracion: decl?.tipoDeclaracion ?? null });
  };

  for (const p of periodos) {
    const decl = await compacto(p);
    if (!decl) { avisos.push(`${p}: sin F29 vigente, no hay qué cruzar con el RCV.`); continue; }
    await cruzar(p, decl.codigos, 'F29', decl);
  }

  // D. La propuesta del período en curso, antes de declarar.
  if (o.propuesta) {
    const prop = await f29.propuesta(ejecutor, o.rut, String(o.propuesta));
    if (!prop.casilleros || prop.casilleros.length === 0) {
      avisos.push(`${o.propuesta}: el SII no tiene propuesta para el período.`);
    } else {
      const casilleros = Object.fromEntries(prop.casilleros.map(c => [c.codigo, Number(c.valor)]));
      await cruzar(o.propuesta, casilleros, 'propuesta', null);
    }
  }

  const totales = verificaciones.reduce<Efectos>((t, v) => ({
    creditoOmitido: t.creditoOmitido + (v.fuente === 'F29' ? v.efectos.creditoOmitido : 0),
    retencionDeMas: t.retencionDeMas + (v.fuente === 'F29' ? v.efectos.retencionDeMas : 0),
    ivaCosto: t.ivaCosto + (v.fuente === 'F29' ? v.efectos.ivaCosto : 0),
  }), { creditoOmitido: 0, retencionDeMas: 0, ivaCosto: 0 });

  return {
    rut: o.rut, generadoEn: new Date().toISOString(), diaVencimiento: dia, diaVencimientoOrigen: diaOrigen,
    declaracion, verificaciones, totales, avisos,
  };
}

/** Lista de períodos AAAAMM entre dos, inclusive. */
export function rangoPeriodos(desde: number, hasta: number): number[] {
  const out: number[] = [];
  for (let p = desde; p <= hasta; p = siguientePeriodo(p)) out.push(p);
  return out;
}
