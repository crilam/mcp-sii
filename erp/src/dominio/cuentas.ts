/**
 * Plan de cuentas.
 *
 * Las cuentas forman un árbol. Sólo las hojas reciben movimientos: si una
 * cuenta con hijas pudiera recibirlos, su saldo sería en parte propio y en
 * parte agregado, y ningún reporte podría distinguirlos.
 */

/**
 * El tipo determina el signo natural de la cuenta y en qué estado aparece.
 * `ingreso` y `gasto` son cuentas de resultado: se cierran contra patrimonio
 * al terminar el ejercicio. Las otras tres son de balance y arrastran saldo.
 */
export type TipoCuenta = 'activo' | 'pasivo' | 'patrimonio' | 'ingreso' | 'gasto';

/** Las cuentas de resultado se cierran al fin del ejercicio; las de balance arrastran. */
export const TIPOS_DE_RESULTADO: ReadonlySet<TipoCuenta> = new Set<TipoCuenta>(['ingreso', 'gasto']);

/** Un saldo deudor es positivo en estas; en las demás lo es el acreedor. */
const TIPOS_DEUDORES: ReadonlySet<TipoCuenta> = new Set<TipoCuenta>(['activo', 'gasto']);

export type SaldoNatural = 'deudor' | 'acreedor';

export function saldoNatural(tipo: TipoCuenta): SaldoNatural {
  return TIPOS_DEUDORES.has(tipo) ? 'deudor' : 'acreedor';
}

export function esDeResultado(tipo: TipoCuenta): boolean {
  return TIPOS_DE_RESULTADO.has(tipo);
}

export interface Cuenta {
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: TipoCuenta;
  /** `null` en las cuentas de primer nivel. */
  readonly padreCodigo: string | null;
  /**
   * Una cuenta inactiva conserva sus movimientos históricos y aparece en los
   * reportes de períodos pasados, pero no acepta movimientos nuevos.
   */
  readonly activa: boolean;
}

export class PlanDeCuentasInvalido extends Error {
  constructor(readonly problemas: readonly string[]) {
    super(`Plan de cuentas inválido:\n  ${problemas.join('\n  ')}`);
    this.name = 'PlanDeCuentasInvalido';
  }
}

export class PlanDeCuentas {
  private readonly porCodigo: ReadonlyMap<string, Cuenta>;
  private readonly codigosConHijas: ReadonlySet<string>;

  private constructor(cuentas: readonly Cuenta[]) {
    this.porCodigo = new Map(cuentas.map((c) => [c.codigo, c]));
    this.codigosConHijas = new Set(
      cuentas.map((c) => c.padreCodigo).filter((p): p is string => p !== null),
    );
  }

  /**
   * Construye el plan validándolo entero. Se valida al construir y no al usar
   * porque un plan mal formado hace que todos los reportes mientan a la vez, y
   * conviene que falle en un lugar identificable y no en el primer balance que
   * alguien mire.
   */
  static desde(cuentas: readonly Cuenta[]): PlanDeCuentas {
    const problemas: string[] = [];
    const vistos = new Set<string>();

    for (const cuenta of cuentas) {
      if (cuenta.codigo.trim() === '') {
        problemas.push('hay una cuenta con código vacío');
        continue;
      }
      if (vistos.has(cuenta.codigo)) {
        problemas.push(`código duplicado: ${cuenta.codigo}`);
      }
      vistos.add(cuenta.codigo);
    }

    const porCodigo = new Map(cuentas.map((c) => [c.codigo, c]));

    for (const cuenta of cuentas) {
      if (cuenta.padreCodigo === null) continue;

      const padre = porCodigo.get(cuenta.padreCodigo);
      if (padre === undefined) {
        problemas.push(`${cuenta.codigo} referencia un padre inexistente: ${cuenta.padreCodigo}`);
        continue;
      }
      if (padre.tipo !== cuenta.tipo) {
        // Una hija de otro tipo que su padre haría que el subtotal del padre
        // mezclara naturalezas y que la cuenta apareciera en el estado equivocado.
        problemas.push(
          `${cuenta.codigo} es ${cuenta.tipo} pero su padre ${padre.codigo} es ${padre.tipo}`,
        );
      }
    }

    for (const cuenta of cuentas) {
      const cicloDesde = detectarCiclo(cuenta, porCodigo);
      if (cicloDesde !== null) {
        problemas.push(`ciclo en la jerarquía: ${cicloDesde.join(' → ')}`);
      }
    }

    if (problemas.length > 0) {
      throw new PlanDeCuentasInvalido([...new Set(problemas)].sort());
    }

    return new PlanDeCuentas(cuentas);
  }

  buscar(codigo: string): Cuenta | undefined {
    return this.porCodigo.get(codigo);
  }

  /** Sólo las hojas reciben movimientos. */
  esHoja(codigo: string): boolean {
    return this.porCodigo.has(codigo) && !this.codigosConHijas.has(codigo);
  }

  todas(): readonly Cuenta[] {
    return [...this.porCodigo.values()];
  }

  hojas(): readonly Cuenta[] {
    return this.todas().filter((c) => this.esHoja(c.codigo));
  }

  /** La cuenta y todas sus descendientes, para los subtotales de los reportes. */
  ramaDe(codigo: string): readonly Cuenta[] {
    const rama: Cuenta[] = [];
    const pendientes = [codigo];
    while (pendientes.length > 0) {
      const actual = pendientes.pop() as string;
      const cuenta = this.porCodigo.get(actual);
      if (cuenta === undefined) continue;
      rama.push(cuenta);
      for (const otra of this.porCodigo.values()) {
        if (otra.padreCodigo === actual) pendientes.push(otra.codigo);
      }
    }
    return rama;
  }
}

/** Devuelve el camino del ciclo si la cuenta es su propia ancestra. */
function detectarCiclo(
  inicio: Cuenta,
  porCodigo: ReadonlyMap<string, Cuenta>,
): readonly string[] | null {
  const camino: string[] = [inicio.codigo];
  const visitados = new Set<string>([inicio.codigo]);
  let actual: Cuenta | undefined = inicio;

  while (actual?.padreCodigo != null) {
    const siguiente: Cuenta | undefined = porCodigo.get(actual.padreCodigo);
    if (siguiente === undefined) return null; // padre inexistente: ya se reporta aparte
    camino.push(siguiente.codigo);
    if (visitados.has(siguiente.codigo)) return camino;
    visitados.add(siguiente.codigo);
    actual = siguiente;
  }

  return null;
}
