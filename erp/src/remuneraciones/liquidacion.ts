/**
 * Liquidación de remuneraciones.
 *
 * **Todo el contenido tributario y previsional de este archivo son parámetros
 * cargados.** Acá está la secuencia del cálculo —qué se suma, qué se tope, qué
 * se descuenta y en qué orden— y ningún valor.
 *
 * Es el sub-proyecto donde la regla del proyecto más importa: no hay endpoint
 * del SII contra el cual verificar una tasa de AFP ni un tramo del impuesto
 * único. Un motor que los genere de memoria produce liquidaciones **plausibles**
 * y equivocadas, y una liquidación equivocada es plata que alguien recibe de
 * menos o una cotización que no se enteró.
 *
 * La secuencia misma también debería validarla un contador antes de usar esto
 * para pagar sueldos de verdad: es normativa interpretada, no aritmética.
 */
import { type ClavePeriodo } from '../dominio/periodos';
import { type Pesos } from '../dominio/dinero';
import { type TablaDeParametros } from '../parametros/tabla';
import { type TablaDeTramos } from '../parametros/tramos';

export type SistemaDeSalud = 'fonasa' | 'isapre';
export type TipoDeContrato = 'indefinido' | 'plazo_fijo';

export interface Trabajador {
  readonly id: string;
  /** Código de la AFP, para buscar su tasa en los parámetros. */
  readonly afpCodigo: string;
  readonly sistemaSalud: SistemaDeSalud;
  /** Plan pactado en UF. Sólo en isapre. */
  readonly planSaludUf?: number;
  readonly tipoContrato: TipoDeContrato;
}

export interface Haberes {
  readonly sueldoBase: Pesos;
  readonly gratificacion: Pesos;
  readonly horasExtra: Pesos;
  /** Bonos y comisiones que sí cotizan. */
  readonly otrosImponibles: Pesos;
  /** Colación, movilización y asignaciones que no cotizan ni tributan. */
  readonly noImponibles: Pesos;
}

export interface Cotizacion {
  readonly concepto: string;
  readonly base: Pesos;
  readonly tasa: number;
  readonly monto: Pesos;
  /** Nombre del parámetro del que salió la tasa, para poder auditarla. */
  readonly parametro: string;
}

export interface Liquidacion {
  readonly trabajadorId: string;
  readonly periodo: ClavePeriodo;

  readonly totalImponible: Pesos;
  readonly totalNoImponible: Pesos;
  readonly totalHaberes: Pesos;

  /** Tope imponible del período, ya convertido a pesos. */
  readonly topeImponibleAfp: Pesos;
  readonly imponibleTopadoAfp: Pesos;

  readonly cotizaciones: readonly Cotizacion[];
  readonly totalCotizacionesTrabajador: Pesos;

  readonly baseTributable: Pesos;
  readonly baseTributableUtm: number;
  readonly impuestoUnico: Pesos;

  readonly totalDescuentos: Pesos;
  readonly liquidoAPagar: Pesos;

  /** Lo que le cuesta al empleador por encima del bruto. */
  readonly aportesDelEmpleador: readonly Cotizacion[];
  readonly costoEmpleador: Pesos;
}

/** Los parámetros que el cálculo va a pedir. Sirve para saber qué cargar antes. */
export function parametrosRequeridos(trabajador: Trabajador): readonly string[] {
  const comunes = [
    'previsional.uf.valor',
    'previsional.utm.valor',
    'previsional.tope_imponible_afp_uf',
    'previsional.tope_imponible_salud_uf',
    'previsional.tope_imponible_cesantia_uf',
    `previsional.afp.${trabajador.afpCodigo}.tasa`,
    'previsional.salud.tasa_legal',
    'previsional.sis.tasa',
    'previsional.mutual.tasa',
  ];

  const cesantia =
    trabajador.tipoContrato === 'indefinido'
      ? ['previsional.cesantia.trabajador.indefinido', 'previsional.cesantia.empleador.indefinido']
      : ['previsional.cesantia.empleador.plazo_fijo'];

  return [...comunes, ...cesantia];
}

export interface EntradaDeLiquidacion {
  readonly trabajador: Trabajador;
  readonly periodo: ClavePeriodo;
  readonly haberes: Haberes;
  readonly parametros: TablaDeParametros;
  /** Tabla del impuesto único de segunda categoría, en UTM. */
  readonly tramosImpuestoUnico: TablaDeTramos;
}

/**
 * Los montos previsionales se redondean al peso.
 *
 * Se hace en un solo lugar y siempre igual, para que la diferencia entre esta
 * liquidación y la del sistema anterior nunca sea "depende de dónde se redondeó".
 * Cuál es el redondeo correcto es una decisión que hay que confirmar con quien
 * lleva las remuneraciones hoy.
 */
function aPeso(monto: number): Pesos {
  return Math.round(monto);
}

export function liquidar(entrada: EntradaDeLiquidacion): Liquidacion {
  const { trabajador, periodo, haberes, parametros, tramosImpuestoUnico } = entrada;

  // Falla con la lista completa: cargar de a uno obliga a reintentar tantas
  // veces como parámetros falten.
  parametros.exigir(parametrosRequeridos(trabajador), periodo);

  if (!tramosImpuestoUnico.tiene(periodo)) {
    tramosImpuestoUnico.vigenteEn(periodo); // lanza con el mensaje correcto
  }

  const uf = parametros.valor('previsional.uf.valor', periodo);
  const utm = parametros.valor('previsional.utm.valor', periodo);

  const totalImponible =
    haberes.sueldoBase + haberes.gratificacion + haberes.horasExtra + haberes.otrosImponibles;
  const totalNoImponible = haberes.noImponibles;
  const totalHaberes = totalImponible + totalNoImponible;

  const topeAfp = aPeso(parametros.valor('previsional.tope_imponible_afp_uf', periodo) * uf);
  const topeSalud = aPeso(parametros.valor('previsional.tope_imponible_salud_uf', periodo) * uf);
  const topeCesantia = aPeso(
    parametros.valor('previsional.tope_imponible_cesantia_uf', periodo) * uf,
  );

  const imponibleAfp = Math.min(totalImponible, topeAfp);
  const imponibleSalud = Math.min(totalImponible, topeSalud);
  const imponibleCesantia = Math.min(totalImponible, topeCesantia);

  const cotizaciones: Cotizacion[] = [];

  const tasaAfp = parametros.valor(`previsional.afp.${trabajador.afpCodigo}.tasa`, periodo);
  cotizaciones.push({
    concepto: `AFP ${trabajador.afpCodigo}`,
    base: imponibleAfp,
    tasa: tasaAfp,
    monto: aPeso(imponibleAfp * tasaAfp),
    parametro: `previsional.afp.${trabajador.afpCodigo}.tasa`,
  });

  cotizaciones.push(cotizacionDeSalud(trabajador, imponibleSalud, uf, periodo, parametros));

  if (trabajador.tipoContrato === 'indefinido') {
    const tasa = parametros.valor('previsional.cesantia.trabajador.indefinido', periodo);
    cotizaciones.push({
      concepto: 'Seguro de cesantía (trabajador)',
      base: imponibleCesantia,
      tasa,
      monto: aPeso(imponibleCesantia * tasa),
      parametro: 'previsional.cesantia.trabajador.indefinido',
    });
  }

  const totalCotizacionesTrabajador = cotizaciones.reduce((s, c) => s + c.monto, 0);

  // El impuesto único se calcula sobre lo imponible menos las cotizaciones
  // previsionales, no sobre el bruto.
  const baseTributable = totalImponible - totalCotizacionesTrabajador;
  const baseTributableUtm = baseTributable / utm;
  const { impuesto: impuestoUtm } = tramosImpuestoUnico.aplicar(baseTributableUtm, periodo);
  const impuestoUnico = aPeso(impuestoUtm * utm);

  const totalDescuentos = totalCotizacionesTrabajador + impuestoUnico;
  const liquidoAPagar = totalHaberes - totalDescuentos;

  const aportesDelEmpleador = aportesEmpleador(
    trabajador,
    { imponibleAfp, imponibleCesantia },
    periodo,
    parametros,
  );

  return {
    trabajadorId: trabajador.id,
    periodo,
    totalImponible,
    totalNoImponible,
    totalHaberes,
    topeImponibleAfp: topeAfp,
    imponibleTopadoAfp: imponibleAfp,
    cotizaciones,
    totalCotizacionesTrabajador,
    baseTributable,
    baseTributableUtm,
    impuestoUnico,
    totalDescuentos,
    liquidoAPagar,
    aportesDelEmpleador,
    costoEmpleador: totalHaberes + aportesDelEmpleador.reduce((s, a) => s + a.monto, 0),
  };
}

/**
 * En isapre se cotiza el mayor entre el plan pactado y la cotización legal: el
 * plan es un piso contractual, no un reemplazo del mínimo legal.
 */
function cotizacionDeSalud(
  trabajador: Trabajador,
  imponibleSalud: Pesos,
  uf: number,
  periodo: ClavePeriodo,
  parametros: TablaDeParametros,
): Cotizacion {
  const tasaLegal = parametros.valor('previsional.salud.tasa_legal', periodo);
  const legal = aPeso(imponibleSalud * tasaLegal);

  if (trabajador.sistemaSalud === 'fonasa' || trabajador.planSaludUf === undefined) {
    return {
      concepto: 'Salud',
      base: imponibleSalud,
      tasa: tasaLegal,
      monto: legal,
      parametro: 'previsional.salud.tasa_legal',
    };
  }

  const plan = aPeso(trabajador.planSaludUf * uf);
  return {
    concepto: plan > legal ? 'Salud (plan isapre)' : 'Salud',
    base: imponibleSalud,
    tasa: tasaLegal,
    monto: Math.max(plan, legal),
    parametro: plan > legal ? 'previsional.uf.valor' : 'previsional.salud.tasa_legal',
  };
}

function aportesEmpleador(
  trabajador: Trabajador,
  bases: { imponibleAfp: Pesos; imponibleCesantia: Pesos },
  periodo: ClavePeriodo,
  parametros: TablaDeParametros,
): readonly Cotizacion[] {
  const aportes: Cotizacion[] = [];

  const tasaSis = parametros.valor('previsional.sis.tasa', periodo);
  aportes.push({
    concepto: 'Seguro de invalidez y sobrevivencia',
    base: bases.imponibleAfp,
    tasa: tasaSis,
    monto: aPeso(bases.imponibleAfp * tasaSis),
    parametro: 'previsional.sis.tasa',
  });

  const tasaMutual = parametros.valor('previsional.mutual.tasa', periodo);
  aportes.push({
    concepto: 'Mutual de seguridad',
    base: bases.imponibleAfp,
    tasa: tasaMutual,
    monto: aPeso(bases.imponibleAfp * tasaMutual),
    parametro: 'previsional.mutual.tasa',
  });

  const nombreCesantia =
    trabajador.tipoContrato === 'indefinido'
      ? 'previsional.cesantia.empleador.indefinido'
      : 'previsional.cesantia.empleador.plazo_fijo';
  const tasaCesantia = parametros.valor(nombreCesantia, periodo);
  aportes.push({
    concepto: 'Seguro de cesantía (empleador)',
    base: bases.imponibleCesantia,
    tasa: tasaCesantia,
    monto: aPeso(bases.imponibleCesantia * tasaCesantia),
    parametro: nombreCesantia,
  });

  return aportes;
}
