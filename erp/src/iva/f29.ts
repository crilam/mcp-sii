/**
 * Armado del F29 a partir de la determinación del IVA.
 *
 * **Los códigos del formulario no están escritos acá.** Salen de la tabla de
 * parámetros, cargados y con vigencia, por la misma razón que las tasas
 * previsionales: no hay endpoint del SII que los devuelva, así que escribirlos
 * de memoria sería inventar un dato que se ve correcto.
 *
 * Además cambian entre versiones del formulario. Un código correcto en 2024 y
 * movido en 2026 produciría una declaración mal armada que igual "cuadra".
 *
 * El sistema arma el formulario; **presentarlo lo hace la persona en el portal
 * del SII**. Nada de esto escribe en el SII.
 */
import { type ClavePeriodo } from '../dominio/periodos';
import { type Pesos } from '../dominio/dinero';
import { type TablaDeParametros } from '../parametros/tabla';
import { type DeterminacionDeIva } from './determinacion';

/**
 * Los conceptos que este sistema sabe determinar, con el nombre del parámetro
 * que guarda su código en el formulario.
 *
 * Es deliberadamente corto: sólo lo que sale del RCV y se puede verificar. Un
 * F29 real tiene muchos más recuadros (PPM, retenciones, impuestos
 * adicionales), y cada uno entra cuando su cálculo esté construido, no antes.
 */
export const CONCEPTOS_DEL_F29 = [
  { concepto: 'ventasNetas', parametro: 'f29.codigo.ventas_netas', descripcion: 'Ventas netas afectas' },
  { concepto: 'ventasExentas', parametro: 'f29.codigo.ventas_exentas', descripcion: 'Ventas exentas' },
  { concepto: 'debitoFiscal', parametro: 'f29.codigo.debito_fiscal', descripcion: 'Débito fiscal del período' },
  { concepto: 'comprasNetas', parametro: 'f29.codigo.compras_netas', descripcion: 'Compras netas' },
  {
    concepto: 'creditoFiscalDelPeriodo',
    parametro: 'f29.codigo.credito_fiscal',
    descripcion: 'Crédito fiscal del período',
  },
  {
    concepto: 'remanenteAnterior',
    parametro: 'f29.codigo.remanente_anterior',
    descripcion: 'Remanente de crédito fiscal del período anterior',
  },
  {
    concepto: 'remanenteParaElSiguiente',
    parametro: 'f29.codigo.remanente_siguiente',
    descripcion: 'Remanente de crédito fiscal para el período siguiente',
  },
  {
    concepto: 'impuestoAPagar',
    parametro: 'f29.codigo.impuesto_a_pagar',
    descripcion: 'IVA determinado a pagar',
  },
] as const;

export type ConceptoDelF29 = (typeof CONCEPTOS_DEL_F29)[number]['concepto'];

export interface CampoDelF29 {
  readonly codigo: number;
  readonly concepto: ConceptoDelF29;
  readonly descripcion: string;
  readonly monto: Pesos;
}

export interface FormularioF29 {
  readonly empresaRut: string;
  readonly periodo: ClavePeriodo;
  readonly campos: readonly CampoDelF29[];
  /**
   * De dónde salió cada cifra. El F29 se presenta a mano en el portal, así que
   * quien lo tipee tiene que poder verificar antes de firmar.
   */
  readonly determinacion: DeterminacionDeIva;
  /**
   * Recordatorio explícito de que esto no está presentado. El sistema no
   * escribe en el SII: lo arma y alguien lo presenta.
   */
  readonly estado: 'armado_sin_presentar';
}

export class CodigosDelF29Faltantes extends Error {
  constructor(
    readonly periodo: ClavePeriodo,
    readonly faltantes: readonly { parametro: string; descripcion: string }[],
  ) {
    super(
      `No se puede armar el F29 de ${periodo}: faltan ${faltantes.length} código(s) del ` +
        'formulario en la tabla de parámetros.\n' +
        faltantes.map((f) => `  ${f.parametro} — ${f.descripcion}`).join('\n') +
        '\nLos códigos no se deducen: cargálos desde el formulario vigente del SII, con su ' +
        'período de vigencia y su fuente.',
    );
    this.name = 'CodigosDelF29Faltantes';
  }
}

/**
 * Arma el formulario. Falla con la lista completa de códigos faltantes, no con
 * el primero: cargarlos de a uno obliga a reintentar tantas veces como falten.
 */
export function armarF29(
  determinacion: DeterminacionDeIva,
  parametros: TablaDeParametros,
): FormularioF29 {
  const { periodo } = determinacion;

  const faltantes = CONCEPTOS_DEL_F29.filter((c) => !parametros.tiene(c.parametro, periodo)).map(
    (c) => ({ parametro: c.parametro, descripcion: c.descripcion }),
  );

  if (faltantes.length > 0) throw new CodigosDelF29Faltantes(periodo, faltantes);

  const campos: CampoDelF29[] = CONCEPTOS_DEL_F29.map((c) => ({
    codigo: parametros.valor(c.parametro, periodo),
    concepto: c.concepto,
    descripcion: c.descripcion,
    monto: determinacion[c.concepto],
  }));

  const repetidos = codigosRepetidos(campos);
  if (repetidos.length > 0) {
    // Dos conceptos en el mismo código significa que uno pisa al otro en el
    // formulario, y la declaración sale mal sin que nada lo delate.
    throw new Error(
      `La tabla de parámetros asigna el mismo código del F29 a más de un concepto en ${periodo}: ` +
        repetidos.map((r) => `${r.codigo} (${r.conceptos.join(', ')})`).join('; '),
    );
  }

  return {
    empresaRut: determinacion.empresaRut,
    periodo,
    campos,
    determinacion,
    estado: 'armado_sin_presentar',
  };
}

function codigosRepetidos(
  campos: readonly CampoDelF29[],
): readonly { codigo: number; conceptos: string[] }[] {
  const porCodigo = new Map<number, string[]>();
  for (const campo of campos) {
    porCodigo.set(campo.codigo, [...(porCodigo.get(campo.codigo) ?? []), campo.concepto]);
  }
  return [...porCodigo.entries()]
    .filter(([, conceptos]) => conceptos.length > 1)
    .map(([codigo, conceptos]) => ({ codigo, conceptos }));
}

/** Qué códigos hay que cargar antes de poder armar el F29 de este período. */
export function codigosQueFaltan(
  periodo: ClavePeriodo,
  parametros: TablaDeParametros,
): readonly string[] {
  return parametros.faltantes(
    CONCEPTOS_DEL_F29.map((c) => c.parametro),
    periodo,
  );
}
