import { ReporteF29 } from './recolector';
import { pesos, Hallazgo } from './reglas';

// Reporte en texto para la terminal. El JSON es el ReporteF29 tal cual.

const MARCA: Record<Hallazgo['severidad'], string> = { error: 'ERROR', advertencia: 'AVISO', info: 'INFO', ok: 'ok' };

const num = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('es-CL'));

export function reporteEnTexto(r: ReporteF29, opciones: { soloDiferencias?: boolean } = {}): string {
  const l: string[] = [];
  const d = r.declaracion;
  l.push(`F29 de ${r.rut} · generado ${r.generadoEn}`);
  l.push('');
  l.push(`Declaración del período vencido ${d.periodo} (vence ${d.vence}, día ${r.diaVencimiento} según ${r.diaVencimientoOrigen}):`);
  l.push(`  ${d.estado.toUpperCase()}${d.folio ? ` · folio ${d.folio} · ${d.tipoDeclaracion ?? ''} · presentado ${d.fechaPresentacion ?? '—'}` : ''}`);

  for (const v of r.verificaciones) {
    l.push('');
    const titulo = v.fuente === 'F29'
      ? `F29 ${v.periodo} declarado (folio ${v.folio ?? '—'}, ${v.tipoDeclaracion ?? '—'}, ${v.fechaPresentacion ?? '—'}) contra el RCV`
      : `Propuesta del SII para ${v.periodo} contra el RCV`;
    l.push(titulo);
    l.push(`  Condición IVA: ${v.condicion.condicion}. ${v.condicion.motivo}`);
    const filas = v.hallazgos.filter(h => !opciones.soloDiferencias || h.severidad !== 'ok');
    const ancho = { cod: 8, num: 14 };
    l.push(`  ${'Código'.padEnd(ancho.cod)} ${'Declarado'.padStart(ancho.num)} ${'Esperado'.padStart(ancho.num)} ${'Diferencia'.padStart(ancho.num)}  Sev.   Explicación`);
    for (const h of filas) {
      l.push(`  ${h.codigo.padEnd(ancho.cod)} ${num(h.declarado).padStart(ancho.num)} ${num(h.esperado).padStart(ancho.num)} ${num(h.diferencia).padStart(ancho.num)}  ${MARCA[h.severidad].padEnd(6)} ${h.concepto}. ${h.explicacion}`);
    }
    l.push(`  Fuentes: declarado = ${v.fuente === 'F29' ? 'F29 declarado (PDF)' : 'propuesta del SII'}; esperado = RCV, o cálculo en las líneas de totales y atípicos.`);
    const e = v.efectos;
    l.push(`  Efecto: crédito omitido ${pesos(e.creditoOmitido)} · retención pagada de más ${pesos(e.retencionDeMas)}${e.ivaCosto ? ` · IVA de tipo 46 que es costo ${pesos(e.ivaCosto)}` : ''} (cálculo)`);
  }

  if (r.verificaciones.some(v => v.fuente === 'F29')) {
    l.push('');
    l.push(`TOTAL F29 declarados: crédito omitido ${pesos(r.totales.creditoOmitido)} · retención pagada de más ${pesos(r.totales.retencionDeMas)}${r.totales.ivaCosto ? ` · IVA costo ${pesos(r.totales.ivaCosto)}` : ''} (cálculo)`);
  }
  for (const a of r.avisos) l.push(`Aviso: ${a}`);
  return l.join('\n');
}
