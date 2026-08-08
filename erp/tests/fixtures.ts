/**
 * Plan de cuentas y un mes de movimientos usados por los tests.
 *
 * Los montos son inventados y redondos a propósito, para que el balance de
 * comprobación esperado pueda calcularse a mano y escribirse como constante.
 * Un test cuyo resultado esperado se obtiene corriendo el mismo código que
 * pretende verificar no verifica nada.
 */
import { type Cuenta, PlanDeCuentas } from '../src/dominio/cuentas';
import { Calendario } from '../src/dominio/periodos';
import { type Asiento, type Borrador, aprobar } from '../src/dominio/asiento';

export const EMPRESA = '11111111-1';

export const CUENTAS: readonly Cuenta[] = [
  { codigo: '1', nombre: 'Activo', tipo: 'activo', padreCodigo: null, activa: true },
  { codigo: '1101', nombre: 'Caja', tipo: 'activo', padreCodigo: '1', activa: true },
  { codigo: '1102', nombre: 'Banco', tipo: 'activo', padreCodigo: '1', activa: true },
  { codigo: '1103', nombre: 'IVA crédito fiscal', tipo: 'activo', padreCodigo: '1', activa: true },
  { codigo: '1199', nombre: 'Cuenta dada de baja', tipo: 'activo', padreCodigo: '1', activa: false },

  { codigo: '2', nombre: 'Pasivo', tipo: 'pasivo', padreCodigo: null, activa: true },
  { codigo: '2101', nombre: 'Proveedores', tipo: 'pasivo', padreCodigo: '2', activa: true },
  { codigo: '2102', nombre: 'IVA débito fiscal', tipo: 'pasivo', padreCodigo: '2', activa: true },

  { codigo: '3', nombre: 'Patrimonio', tipo: 'patrimonio', padreCodigo: null, activa: true },
  { codigo: '3101', nombre: 'Capital', tipo: 'patrimonio', padreCodigo: '3', activa: true },

  { codigo: '4', nombre: 'Ingresos', tipo: 'ingreso', padreCodigo: null, activa: true },
  { codigo: '4101', nombre: 'Ventas', tipo: 'ingreso', padreCodigo: '4', activa: true },

  { codigo: '5', nombre: 'Gastos', tipo: 'gasto', padreCodigo: null, activa: true },
  { codigo: '5101', nombre: 'Costo de ventas', tipo: 'gasto', padreCodigo: '5', activa: true },
  { codigo: '5102', nombre: 'Remuneraciones', tipo: 'gasto', padreCodigo: '5', activa: true },
];

export function plan(): PlanDeCuentas {
  return PlanDeCuentas.desde(CUENTAS);
}

export function calendario(): Calendario {
  return new Calendario([
    { clave: '202512', estado: 'cerrado' },
    { clave: '202601', estado: 'abierto' },
    { clave: '202602', estado: 'abierto' },
  ]);
}

export function borrador(parcial: Partial<Borrador> = {}): Borrador {
  return {
    id: 'b-1',
    empresaRut: EMPRESA,
    fecha: '2026-01-15',
    glosa: 'Movimiento de prueba',
    origen: 'manual',
    lineas: [
      { cuentaCodigo: '1101', debe: 1000, haber: 0 },
      { cuentaCodigo: '4101', debe: 0, haber: 1000 },
    ],
    ...parcial,
  };
}

/**
 * Enero completo. El balance de comprobación esperado está calculado a mano en
 * `enero.esperado.ts`.
 */
const BORRADORES_DE_ENERO: readonly Borrador[] = [
  {
    id: 'b-venta',
    empresaRut: EMPRESA,
    fecha: '2026-01-05',
    glosa: 'Venta al contado, boleta 1',
    origen: 'regla',
    referencia: 'BOL-1',
    lineas: [
      { cuentaCodigo: '1101', debe: 119_000, haber: 0 },
      { cuentaCodigo: '4101', debe: 0, haber: 100_000 },
      { cuentaCodigo: '2102', debe: 0, haber: 19_000 },
    ],
  },
  {
    id: 'b-compra',
    empresaRut: EMPRESA,
    fecha: '2026-01-10',
    glosa: 'Compra de mercadería, factura 500',
    origen: 'regla',
    referencia: 'FAC-500',
    lineas: [
      { cuentaCodigo: '5101', debe: 50_000, haber: 0 },
      { cuentaCodigo: '1103', debe: 9_500, haber: 0 },
      { cuentaCodigo: '2101', debe: 0, haber: 59_500 },
    ],
  },
  {
    id: 'b-pago',
    empresaRut: EMPRESA,
    fecha: '2026-01-20',
    glosa: 'Pago a proveedor, factura 500',
    origen: 'manual',
    referencia: 'FAC-500',
    lineas: [
      { cuentaCodigo: '2101', debe: 59_500, haber: 0 },
      { cuentaCodigo: '1102', debe: 0, haber: 59_500 },
    ],
  },
  {
    id: 'b-sueldos',
    empresaRut: EMPRESA,
    fecha: '2026-01-31',
    glosa: 'Remuneraciones de enero',
    origen: 'manual',
    lineas: [
      { cuentaCodigo: '5102', debe: 800_000, haber: 0 },
      { cuentaCodigo: '1102', debe: 0, haber: 800_000 },
    ],
  },
];

export function asientosDeEnero(): readonly Asiento[] {
  const p = plan();
  const c = calendario();
  return BORRADORES_DE_ENERO.map((b, indice) =>
    aprobar(b, p, c, {
      numero: indice + 1,
      aprobadoPor: 'prueba',
      aprobadoEn: '2026-02-01T10:00:00Z',
    }),
  );
}
