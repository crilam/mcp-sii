// Plazo de declaración del F29: el mes siguiente al período, el día 20 si el
// contribuyente está autorizado a declarar ese día (facturador electrónico; la
// ficha de Mi SII lo trae como `autorizadoDeclararDia20`) y el 12 si no. Si el
// día cae en sábado, domingo o feriado, corre al siguiente hábil.

// Feriados de fecha fija. Los móviles (Viernes Santo, los trasladados por ley)
// no caen nunca en un 12 o un 20 de forma predecible: se agregan con
// `feriadosExtra` cuando hagan falta.
const FERIADOS_FIJOS = ['01-01', '05-01', '05-21', '06-29', '07-16', '08-15', '09-18', '09-19', '10-12', '10-31', '11-01', '12-08', '12-25'];

export type EstadoPlazo = 'vigente' | 'vigente fuera de plazo' | 'no presentado' | 'no presentado, dentro de plazo';

/** AAAAMM del último período cuyo plazo ya pasó o vence hoy: el mes anterior. */
export function periodoVencido(hoy: Date): number {
  const y = hoy.getFullYear();
  const m = hoy.getMonth() + 1;
  return m === 1 ? (y - 1) * 100 + 12 : y * 100 + (m - 1);
}

export function siguientePeriodo(periodo: number): number {
  const y = Math.floor(periodo / 100);
  const m = periodo % 100;
  return m === 12 ? (y + 1) * 100 + 1 : y * 100 + m + 1;
}

export function anteriorPeriodo(periodo: number): number {
  const y = Math.floor(periodo / 100);
  const m = periodo % 100;
  return m === 1 ? (y - 1) * 100 + 12 : y * 100 + m - 1;
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Fecha de vencimiento (fecha local, sin hora) del F29 de un período. */
export function vencimiento(periodo: number, dia: 12 | 20, feriadosExtra: string[] = []): Date {
  const sig = siguientePeriodo(periodo);
  const d = new Date(Math.floor(sig / 100), (sig % 100) - 1, dia);
  const inhabil = (x: Date) =>
    x.getDay() === 0 || x.getDay() === 6
    || FERIADOS_FIJOS.includes(iso(x).slice(5))
    || feriadosExtra.includes(iso(x));
  while (inhabil(d)) d.setDate(d.getDate() + 1);
  return d;
}

/** "dd/mm/aaaa" del SII a fecha local. */
export function fechaSii(texto: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto.trim());
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

export function estadoPlazo(
  presentado: { fechaPresentacion: string | null } | null,
  vence: Date,
  hoy: Date
): EstadoPlazo {
  const dia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (!presentado) return dia(hoy) <= dia(vence) ? 'no presentado, dentro de plazo' : 'no presentado';
  const f = presentado.fechaPresentacion ? fechaSii(presentado.fechaPresentacion) : null;
  return f && dia(f) > dia(vence) ? 'vigente fuera de plazo' : 'vigente';
}

export { iso as fechaIso };
