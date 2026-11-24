import { ResumenRcv, FilaDetalleRcv } from '../scrapers/rcv';
import { ActividadContribuyente } from '../scrapers/misii';
import { condicionIva, ResultadoCondicion } from './condicionIva';

// Motor de la verificación: compara los casilleros de un F29 (declarado o
// propuesta del SII) con el Registro de Compras y Ventas del mismo período.
// Puro: no toca el SII, recibe todo armado. Así se prueba con fixtures y la
// misma lógica sirve al CLI y a la tool MCP.
//
// Por qué existe: la propuesta del SII llena el 520 sólo con el IVA de las
// facturas recibidas (33) y omite el de las facturas de compra con retención
// total (46, cambio de sujeto), aunque sí trae la retención (039/596). Quien
// declara la propuesta paga la retención y no usa el crédito.

export type Fuente = 'F29' | 'propuesta' | 'RCV' | 'cálculo';
export type Severidad = 'error' | 'advertencia' | 'info' | 'ok';

export interface Hallazgo {
  /** Casillero, o la línea de cálculo ("538", "520+525", "089+755"). */
  codigo: string;
  concepto: string;
  declarado: number | null;
  esperado: number | null;
  /** declarado − esperado. */
  diferencia: number | null;
  severidad: Severidad;
  explicacion: string;
  fuenteDeclarado: Fuente;
  fuenteEsperado: Fuente;
}

export interface EntradaVerificacion {
  periodo: number;
  /** Casilleros del F29: código (con ceros a la izquierda) → valor. */
  casilleros: Record<string, number>;
  /** 'F29' para la declaración vigente, 'propuesta' para la propuesta del SII. */
  fuente: 'F29' | 'propuesta';
  compras: ResumenRcv;
  ventas: ResumenRcv;
  /** Detalle de las NC (61) de compra. Sin él no se pueden separar las NC sobre tipo 46 ni sobre boletas. */
  ncCompras: FilaDetalleRcv[] | null;
  /** RCV de venta de los meses anteriores (hasta 6), para marcar montos atípicos. */
  ventasAnteriores?: ResumenRcv[];
  actividades?: ActividadContribuyente[];
}

export interface Efectos {
  /** Crédito fiscal neto que correspondía y no se usó (positivo) o que se usó de más (negativo). */
  creditoOmitido: number;
  /** Retención de cambio de sujeto (596) pagada de más (positivo) o de menos (negativo). */
  retencionDeMas: number;
  /** IVA de compras con retención total que es costo por no haber derecho a crédito (exentas). */
  ivaCosto: number;
}

export interface ResultadoVerificacion {
  periodo: number;
  fuente: 'F29' | 'propuesta';
  condicion: ResultadoCondicion;
  hallazgos: Hallazgo[];
  efectos: Efectos;
}

// Notas de crédito que referencian boletas: no dan crédito fiscal (la boleta no
// lo dio), así que no van al 528.
const REF_BOLETA = new Set([35, 38, 39, 41]);
// Facturas de compra (el comprador emite y retiene): 46 retención total, 45
// retención parcial. Su IVA es crédito del comprador.
const FACTURA_COMPRA = new Set([45, 46]);
const CAMBIO_SUJETO = 46;

// Líneas de los totales. Sólo los casilleros que se conocen: si el F29 trae
// otro que también suma o resta, el total no cuadra y se avisa con la lista de
// casilleros sin clasificar, en vez de inventarle un signo.
const DEBITOS_SUMAN = ['502', '111', '513', '759', '717'];
const DEBITOS_RESTAN = ['510', '709', '734'];
const CREDITOS_SUMAN = ['504', '520', '525', '532', '535', '553', '544', '127', '523'];
const CREDITOS_RESTAN = ['528'];
const DETERMINADO_SUMAN = ['089', '048', '151', '062', '153', '123', '703'];

const fila = (r: ResumenRcv, tipo: number) => r.filas.find(f => f.tipoDocCodigo === tipo);
const iva = (r: ResumenRcv, tipos: number[]) => tipos.reduce((s, t) => s + (fila(r, t)?.montoIva ?? 0), 0);
const docs = (r: ResumenRcv, tipos: number[]) => tipos.reduce((s, t) => s + (fila(r, t)?.documentos ?? 0), 0);
const exento = (r: ResumenRcv, tipos: number[]) => tipos.reduce((s, t) => s + (fila(r, t)?.montoExento ?? 0), 0);

export const pesos = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('es-CL');

export function verificar(e: EntradaVerificacion): ResultadoVerificacion {
  const c = e.casilleros;
  const v = (cod: string) => c[cod] ?? 0;
  const tiene = (cod: string) => cod in c;
  const condicion = condicionIva(e.ventas, e.compras, e.actividades);
  const conCredito = condicion.condicion !== 'exenta';
  const hallazgos: Hallazgo[] = [];

  const comparar = (
    codigo: string, concepto: string, declarado: number, esperado: number,
    sevSiDifiere: Severidad, explicar: (dif: number) => string, okTexto = 'Cuadra con el RCV.'
  ) => {
    const dif = declarado - esperado;
    hallazgos.push({
      codigo, concepto, declarado, esperado, diferencia: dif,
      severidad: dif === 0 ? 'ok' : sevSiDifiere,
      explicacion: dif === 0 ? okTexto : explicar(dif),
      fuenteDeclarado: e.fuente, fuenteEsperado: 'RCV',
    });
  };

  // --- Notas de crédito de compra: separar las que van a cada casillero. ---
  const nc = e.ncCompras;
  const ncTotalIva = iva(e.compras, [61]);
  const ncSobre46 = nc ? nc.filter(d => d.referenciaTipoDoc === CAMBIO_SUJETO) : [];
  const ncSobreBoleta = nc ? nc.filter(d => d.referenciaTipoDoc !== null && REF_BOLETA.has(d.referenciaTipoDoc)) : [];
  const ivaNc46 = ncSobre46.reduce((s, d) => s + d.montoIva, 0);
  const ivaNcBoleta = ncSobreBoleta.reduce((s, d) => s + d.montoIva, 0);
  if (!nc && docs(e.compras, [61]) > 0) {
    hallazgos.push({
      codigo: '528', concepto: 'Detalle de NC de compra', declarado: null, esperado: null, diferencia: null,
      severidad: 'advertencia', fuenteDeclarado: e.fuente, fuenteEsperado: 'RCV',
      explicacion: 'Sin el detalle de las NC de compra no se separan las NC sobre facturas de compra (736) ni sobre boletas: 528 y 736 se comparan con el total.',
    });
  }

  // --- Créditos ---
  const ivaFacturas = iva(e.compras, [33]) + iva(e.compras, [...FACTURA_COMPRA]);
  const ivaRetTotal = iva(e.compras, [CAMBIO_SUJETO]);
  const esp520 = conCredito ? ivaFacturas : 0;
  const decl520 = v('520') + v('525');
  const cod520 = tiene('525') ? '520+525' : '520';
  comparar(cod520, 'Crédito por facturas recibidas (giro y activo fijo)', decl520, esp520, 'error', dif => {
    if (!conCredito) return `Contribuyente exento: no tiene derecho a crédito fiscal y declaró ${pesos(decl520)}. El IVA de las compras va como monto sin derecho (562/564).`;
    if (dif < 0 && ivaRetTotal > 0 && v('520') + v('525') === iva(e.compras, [33])) {
      return `Falta el IVA de las facturas de compra con retención total (tipo 46, ${pesos(ivaRetTotal)}): la propuesta del SII lo omite aunque trae la retención. Crédito no usado.`;
    }
    return dif < 0 ? `Se declaró ${pesos(-dif)} menos de crédito que el IVA de las facturas del RCV (33 + 46).` : `Se declaró ${pesos(dif)} más de crédito que el IVA de las facturas del RCV (33 + 46).`;
  });
  const esp519 = docs(e.compras, [33, ...FACTURA_COMPRA]);
  const decl519 = v('519') + v('524');
  if (conCredito || tiene('519')) {
    comparar(tiene('524') ? '519+524' : '519', 'Cantidad de facturas recibidas', decl519, conCredito ? esp519 : 0, 'advertencia',
      dif => `Se informaron ${decl519} facturas y el RCV tiene ${esp519} (33 + 46). ${dif < 0 ? 'Faltan documentos en la cantidad.' : ''}`.trim());
  }

  const esp528 = conCredito ? ncTotalIva - ivaNcBoleta : 0;
  comparar('528', 'Crédito a restar por NC recibidas', v('528'), esp528, 'error', dif => {
    if (dif < 0 && ivaNc46 > 0 && -dif === ivaNc46) {
      return `Faltan las NC emitidas sobre facturas de compra tipo 46 (${pesos(ivaNc46)}): rebajan el crédito de esas facturas.`;
    }
    if (dif > 0 && ivaNcBoleta > 0 && dif === ivaNcBoleta) {
      return `Incluye NC sobre boletas (${pesos(ivaNcBoleta)}), que no rebajan crédito porque la boleta no lo dio.`;
    }
    return dif < 0 ? `Se rebajaron ${pesos(-dif)} menos que las NC del RCV: crédito usado de más.` : `Se rebajaron ${pesos(dif)} más que las NC del RCV: crédito no usado.`;
  });
  // Rebajar las NC del 520 en vez de declararlas en el 528 deja el crédito neto
  // igual: los dos casilleros difieren en el mismo monto y el impuesto no
  // cambia. Es un aviso de forma, no un error de impuesto.
  const h520 = hallazgos.find(h => h.codigo === cod520)!;
  const h528 = hallazgos.find(h => h.codigo === '528' && h.diferencia !== null)!;
  if (conCredito && h520.diferencia && h520.diferencia === h528.diferencia) {
    for (const h of [h520, h528]) {
      h.severidad = 'advertencia';
      h.explicacion = `Las NC por ${pesos(-h520.diferencia)}${ivaNc46 === -h520.diferencia ? ' (sobre facturas tipo 46)' : ''} se rebajaron del 520 en vez de declararse en el 528. El crédito neto no cambia; sólo la forma.`;
    }
  }
  const esp527 = docs(e.compras, [61]) - ncSobreBoleta.length;
  if (conCredito) {
    comparar('527', 'Cantidad de NC recibidas', v('527'), esp527, 'advertencia',
      () => `Se informaron ${v('527')} NC y el RCV tiene ${esp527} (sin contar las NC sobre boletas).`);
  }

  const esp535 = conCredito ? iva(e.compras, [914]) : 0;
  if (esp535 !== 0 || tiene('535')) {
    comparar('535', 'Crédito por IVA de importaciones (DIN)', v('535'), esp535, 'error',
      dif => dif < 0 ? `Falta crédito de importaciones por ${pesos(-dif)} (DIN, tipo 914).` : `Crédito de importaciones ${pesos(dif)} mayor que las DIN del RCV.`);
  }

  // --- Retención de cambio de sujeto ---
  const esp039 = ivaRetTotal;
  const esp736 = ivaNc46;
  const esp596 = esp039 - esp736;
  if (esp039 !== 0 || tiene('039')) {
    comparar('039', 'IVA retenido a terceros (facturas de compra tipo 46)', v('039'), esp039, 'error',
      dif => dif < 0 ? `Falta retener ${pesos(-dif)} de IVA de las facturas de compra tipo 46.` : `Se retuvo ${pesos(dif)} más que el IVA de las facturas tipo 46 del RCV.`);
  }
  if (esp736 !== 0 || tiene('736')) {
    comparar('736', 'Retención a rebajar por NC sobre facturas tipo 46', v('736'), esp736, 'error',
      dif => dif < 0 ? `Faltan las NC emitidas sobre facturas tipo 46 (${pesos(-dif)}): se pagó retención de más.` : `Se rebajaron ${pesos(dif)} más que las NC sobre tipo 46 del RCV.`);
  }
  if (esp596 !== 0 || tiene('596')) {
    comparar('596', 'Retención cambio de sujeto (039 − 736)', v('596'), esp596, 'error',
      dif => dif > 0 ? `Se pagaron ${pesos(dif)} de retención de más.` : `Se pagaron ${pesos(-dif)} de retención de menos.`);
  }
  if (!conCredito && ivaRetTotal > 0) {
    hallazgos.push({
      codigo: '039', concepto: 'IVA de facturas tipo 46 sin derecho a crédito', declarado: null, esperado: ivaRetTotal,
      diferencia: null, severidad: 'info', fuenteDeclarado: e.fuente, fuenteEsperado: 'RCV',
      explicacion: `Contribuyente exento: la retención de las facturas tipo 46 (${pesos(ivaRetTotal)}) se paga igual y ese IVA es costo, no un crédito omitido.`,
    });
  }

  // --- Débitos y exentos ---
  comparar('502', 'Débito por facturas emitidas', v('502'), iva(e.ventas, [33, 30]), 'error',
    dif => `Débito ${dif > 0 ? 'mayor' : 'menor'} que el IVA de las facturas emitidas del RCV por ${pesos(Math.abs(dif))}.`);
  comparar('503', 'Cantidad de facturas emitidas', v('503'), docs(e.ventas, [33, 30]), 'advertencia',
    () => `Se informaron ${v('503')} facturas y el RCV tiene ${docs(e.ventas, [33, 30])}.`);
  comparar('510', 'Débito a rebajar por NC emitidas', v('510'), iva(e.ventas, [61]), 'error',
    dif => `Rebaja ${dif > 0 ? 'mayor' : 'menor'} que el IVA de las NC emitidas del RCV por ${pesos(Math.abs(dif))}.`);
  comparar('509', 'Cantidad de NC emitidas', v('509'), docs(e.ventas, [61]), 'advertencia',
    () => `Se informaron ${v('509')} NC y el RCV tiene ${docs(e.ventas, [61])}.`);
  if (iva(e.ventas, [56]) !== 0 || tiene('513')) {
    comparar('513', 'Débito por notas de débito emitidas', v('513'), iva(e.ventas, [56]), 'error',
      dif => `Débito ${dif > 0 ? 'mayor' : 'menor'} que las notas de débito del RCV por ${pesos(Math.abs(dif))}.`);
  }
  const espExento = exento(e.ventas, [34, 32, 38, 41]);
  if (espExento !== 0 || tiene('142')) {
    comparar('142', 'Ventas exentas o no gravadas', v('142'), espExento, 'advertencia',
      dif => `Ventas exentas ${dif > 0 ? 'mayores' : 'menores'} que el RCV por ${pesos(Math.abs(dif))}. No cambia el impuesto.`);
  }
  const espExport = exento(e.ventas, [110, 111]) + (fila(e.ventas, 110)?.montoNeto ?? 0);
  if (espExport !== 0 || tiene('020')) {
    comparar('020', 'Exportaciones', v('020'), espExport, 'advertencia',
      dif => `Exportaciones ${dif > 0 ? 'mayores' : 'menores'} que el RCV por ${pesos(Math.abs(dif))}. No cambia el impuesto.`);
  }

  atipicos(e, hallazgos);
  if (e.fuente === 'F29') aritmetica(c, hallazgos);

  if (condicion.condicion === 'mixta') {
    hallazgos.push({
      codigo: '520', concepto: 'Proporcionalidad del crédito de uso común', declarado: null, esperado: condicion.ivaUsoComun,
      diferencia: null, severidad: 'advertencia', fuenteDeclarado: e.fuente, fuenteEsperado: 'RCV',
      explicacion: `Revisión manual: hay ventas afectas y exentas, y el crédito de uso común se prorratea (art. 23 N°3 DL 825). El RCV informa ${pesos(condicion.ivaUsoComun)} de IVA de uso común. Esta verificación no calcula la proporción.`,
    });
  }
  if (e.fuente === 'propuesta') {
    hallazgos.push({
      codigo: '—', concepto: 'Propuesta del SII', declarado: null, esperado: null, diferencia: null,
      severidad: 'info', fuenteDeclarado: e.fuente, fuenteEsperado: 'RCV',
      explicacion: 'La propuesta se arma con el RCV del momento en que el SII la generó. En un mes en curso, las diferencias en ventas y cantidades pueden ser documentos posteriores; las del 520/039 de las tipo 46 son el error de la propuesta.',
    });
  }
  if (v('755') > 0) {
    hallazgos.push({
      codigo: '755', concepto: 'IVA postergado', declarado: v('755'), esperado: null, diferencia: null,
      severidad: 'info', fuenteDeclarado: e.fuente, fuenteEsperado: 'cálculo',
      explicacion: `Se postergó ${pesos(v('755'))} de IVA. Rectificar este mes cambia el IVA postergado pendiente.`,
    });
  }

  // --- Efectos en el impuesto ---
  const creditoNeto = (x: { r520: number; r528: number; r535: number }) => x.r520 - x.r528 + x.r535;
  const declNeto = creditoNeto({ r520: decl520, r528: v('528'), r535: v('535') });
  const espNeto = creditoNeto({ r520: esp520, r528: esp528, r535: esp535 });
  const efectos: Efectos = {
    creditoOmitido: espNeto - declNeto,
    retencionDeMas: v('596') - esp596,
    ivaCosto: conCredito ? 0 : ivaRetTotal,
  };
  return { periodo: e.periodo, fuente: e.fuente, condicion, hallazgos, efectos };
}

function atipicos(e: EntradaVerificacion, hallazgos: Hallazgo[]): void {
  const previas = (e.ventasAnteriores ?? []).slice(-6);
  if (previas.length < 3) return;
  for (const [codigo, tipo, concepto] of [['502', 33, 'Débito por facturas emitidas'], ['510', 61, 'Débito a rebajar por NC emitidas']] as const) {
    const prom = previas.reduce((s, r) => s + iva(r, [tipo]), 0) / previas.length;
    const actual = iva(e.ventas, [tipo]);
    if (prom > 0 && actual > 3 * prom) {
      hallazgos.push({
        codigo, concepto: `${concepto}: monto atípico`, declarado: e.casilleros[codigo] ?? 0, esperado: Math.round(prom),
        diferencia: null, severidad: 'advertencia', fuenteDeclarado: e.fuente, fuenteEsperado: 'cálculo',
        explicacion: `El IVA del mes (${pesos(actual)}) es ${(actual / prom).toFixed(1).replace('.', ',')} veces el promedio de los ${previas.length} meses anteriores (${pesos(prom)}). Puede ser un documento con un error de digitación, aunque luego se anule con NC.`,
      });
    }
  }
}

function aritmetica(c: Record<string, number>, hallazgos: Hallazgo[]): void {
  const v = (cod: string) => c[cod] ?? 0;
  const suma = (cods: string[]) => cods.reduce((s, k) => s + v(k), 0);
  const linea = (codigo: string, concepto: string, declarado: number, calculado: number, formula: string, conocidos: string[]) => {
    const dif = declarado - calculado;
    hallazgos.push({
      codigo, concepto, declarado, esperado: calculado, diferencia: dif,
      severidad: dif === 0 ? 'ok' : 'advertencia', fuenteDeclarado: 'F29', fuenteEsperado: 'cálculo',
      explicacion: dif === 0 ? `Cuadra: ${formula}.` : `No cuadra ${formula} por ${pesos(dif)}. Puede faltar un casillero que esta verificación no conoce; casilleros del F29 sin clasificar: ${sinClasificar(c, conocidos).join(', ') || 'ninguno'}.`,
    });
  };
  if ('538' in c) linea('538', 'Total débitos', v('538'), suma(DEBITOS_SUMAN) - suma(DEBITOS_RESTAN), '538 = 502 + 513 + … − 510', [...DEBITOS_SUMAN, ...DEBITOS_RESTAN]);
  if ('537' in c) linea('537', 'Total créditos', v('537'), suma(CREDITOS_SUMAN) - suma(CREDITOS_RESTAN), '537 = 520 + 525 − 528 + 535 + …', [...CREDITOS_SUMAN, ...CREDITOS_RESTAN]);
  if ('538' in c && '537' in c) {
    const neto = v('538') - v('537');
    if (neto > 0) {
      linea('089+755', 'IVA determinado (más el postergado)', v('089') + v('755'), neto, '089 + 755 = 538 − 537', []);
    } else {
      linea('077', 'Remanente de crédito', v('077'), -neto, '077 = 537 − 538', []);
    }
  }
  if ('595' in c) linea('595', 'Subtotal impuesto determinado', v('595'), suma(DETERMINADO_SUMAN), '595 = 089 + 048 + 151 + 062 + …', DETERMINADO_SUMAN);
  if ('547' in c) linea('547', 'Total determinado', v('547'), v('595') + v('596'), '547 = 595 + 596', ['595', '596']);
}

// Casilleros de monto que no son de información (cantidades, bases, tasas) ni
// de ninguna línea conocida: los candidatos a explicar un total que no cuadra.
const INFORMATIVOS = new Set(['020', '039', '060', '60', '077', '089', '115', '142', '503', '509', '511', '512', '519', '524', '527', '531', '534', '538', '537', '547', '562', '563', '584', '585', '586', '595', '596', '736', '755', '779', '9311', '9312']);
function sinClasificar(c: Record<string, number>, conocidos: string[]): string[] {
  return Object.keys(c).filter(k => c[k] !== 0 && !conocidos.includes(k) && !INFORMATIVOS.has(k)
    && ![...DEBITOS_SUMAN, ...DEBITOS_RESTAN, ...CREDITOS_SUMAN, ...CREDITOS_RESTAN, ...DETERMINADO_SUMAN].includes(k));
}
