/**
 * Los montos de la contabilidad son enteros en pesos chilenos.
 *
 * No hay decimales porque la contabilidad en pesos no los usa, y punto
 * flotante en montos produce descuadres de un peso que después hay que
 * perseguir por todo el mayor. Un asiento que no cuadra por redondeo es
 * indistinguible de uno que no cuadra por un error real.
 */
export type Pesos = number;

export class MontoInvalido extends Error {
  constructor(
    readonly valor: unknown,
    readonly motivo: string,
  ) {
    super(`Monto inválido (${String(valor)}): ${motivo}`);
    this.name = 'MontoInvalido';
  }
}

/** Rechaza lo que no puede ser un monto contable antes de que entre al modelo. */
export function validarMonto(valor: unknown): Pesos {
  if (typeof valor !== 'number' || Number.isNaN(valor)) {
    throw new MontoInvalido(valor, 'no es un número');
  }
  if (!Number.isFinite(valor)) {
    throw new MontoInvalido(valor, 'no es finito');
  }
  if (!Number.isInteger(valor)) {
    throw new MontoInvalido(valor, 'tiene decimales; los montos son enteros en pesos');
  }
  if (valor < 0) {
    throw new MontoInvalido(
      valor,
      'es negativo; el signo lo da la columna debe o haber, no el monto',
    );
  }
  if (!Number.isSafeInteger(valor)) {
    throw new MontoInvalido(valor, 'excede el entero seguro de JavaScript');
  }
  return valor;
}
