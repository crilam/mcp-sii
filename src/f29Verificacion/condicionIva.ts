import { ResumenRcv } from '../scrapers/rcv';
import { ActividadContribuyente } from '../scrapers/misii';

// Condición del contribuyente frente al IVA en un período. Decide si hay
// derecho a crédito fiscal:
//   - afecta: ventas afectas (o exportaciones, que dan derecho a crédito por el
//     art. 36 del DL 825) y ninguna venta exenta.
//   - exenta: sólo ventas exentas. Sin derecho a crédito: el 520 debe ser 0 y
//     el IVA de las compras es costo.
//   - mixta: ventas afectas y exentas. El crédito de uso común se prorratea
//     (art. 23 N°3 DL 825). Esta verificación NO calcula la proporción.
export type CondicionIva = 'afecta' | 'exenta' | 'mixta';

export interface ResultadoCondicion {
  condicion: CondicionIva;
  motivo: string;
  /** Ventas exentas sobre el total de ventas del período (0 a 1), si hubo ventas. */
  proporcionExenta: number | null;
  /** IVA de uso común que informa el RCV de compras: lo que habría que prorratear. */
  ivaUsoComun: number;
}

// Documentos de venta con IVA (facturas, boletas, notas de débito) y
// exportaciones. Las NC no cuentan: restan, no definen la actividad.
const VENTA_AFECTA = new Set([30, 33, 35, 39, 45, 46, 55, 56]);
const EXPORTACION = new Set([110, 111]);
// Documentos de venta sin IVA: factura y boleta exentas.
const VENTA_EXENTA = new Set([32, 34, 38, 41]);

export function condicionIva(
  ventas: ResumenRcv,
  compras: ResumenRcv | null,
  actividades: ActividadContribuyente[] = []
): ResultadoCondicion {
  let afecto = 0;
  let exento = 0;
  let exportado = 0;
  for (const f of ventas.filas) {
    if (VENTA_AFECTA.has(f.tipoDocCodigo)) {
      afecto += f.montoNeto;
      exento += f.montoExento;
    } else if (EXPORTACION.has(f.tipoDocCodigo)) {
      exportado += f.montoExento + f.montoNeto;
    } else if (VENTA_EXENTA.has(f.tipoDocCodigo)) {
      exento += f.montoExento + f.montoNeto;
    }
  }
  const ivaUsoComun = compras?.filas.reduce((s, f) => s + f.montoIvaUsoComun, 0) ?? 0;
  const conDerecho = afecto + exportado;
  const total = conDerecho + exento;
  const proporcionExenta = total > 0 ? exento / total : null;
  const pct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')}%`;

  if (conDerecho > 0 && exento > 0) {
    return {
      condicion: 'mixta', proporcionExenta, ivaUsoComun,
      motivo: `RCV de venta con ventas afectas o exportaciones y ${pct(exento / total)} de ventas exentas: `
        + 'el crédito de uso común se prorratea (art. 23 N°3 DL 825).',
    };
  }
  if (conDerecho > 0) {
    return {
      condicion: 'afecta', proporcionExenta, ivaUsoComun,
      motivo: exportado > 0 && afecto === 0
        ? 'RCV de venta sólo con exportaciones, que dan derecho a crédito (art. 36 DL 825).'
        : 'RCV de venta con ventas afectas y sin ventas exentas.',
    };
  }
  if (exento > 0) {
    return {
      condicion: 'exenta', proporcionExenta, ivaUsoComun,
      motivo: 'RCV de venta sólo con documentos exentos: no hay derecho a crédito fiscal.',
    };
  }

  // Mes sin ventas: decide la ficha de Mi SII. Sin actividades afectas, el
  // contribuyente no tiene con qué usar el crédito.
  const conocidas = actividades.filter(a => a.afectaIva !== null);
  if (conocidas.length > 0 && conocidas.every(a => a.afectaIva === false)) {
    return {
      condicion: 'exenta', proporcionExenta, ivaUsoComun,
      motivo: 'Sin ventas en el período y todas las actividades de Mi SII son no afectas a IVA.',
    };
  }
  if (conocidas.some(a => a.afectaIva === false) && conocidas.some(a => a.afectaIva === true)) {
    return {
      condicion: 'mixta', proporcionExenta, ivaUsoComun,
      motivo: 'Sin ventas en el período; Mi SII registra actividades afectas y no afectas a IVA.',
    };
  }
  return {
    condicion: 'afecta', proporcionExenta, ivaUsoComun,
    motivo: conocidas.length > 0
      ? 'Sin ventas en el período; las actividades de Mi SII son afectas a IVA.'
      : 'Sin ventas en el período ni actividades conocidas: se asume afecta.',
  };
}
