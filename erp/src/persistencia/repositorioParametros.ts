/**
 * Persistencia de parámetros, tramos, liquidaciones y clasificación tributaria.
 *
 * La tabla llega vacía a propósito. Cargar los valores es trabajo de quien
 * tenga la fuente autorizada, y mientras no estén, los motores se niegan a
 * calcular en vez de inventar.
 */
import { type Pool } from 'pg';

import { type ClavePeriodo } from '../dominio/periodos';
import {
  type DefinicionDeParametro,
  type ValorVigente,
  TablaDeParametros,
} from '../parametros/tabla';
import { type TablaDeTramosVigente, TablaDeTramos, type Tramo } from '../parametros/tramos';
import { type Liquidacion } from '../remuneraciones/liquidacion';
import { type ClasificacionDeCuenta } from '../renta/rli';

export class RepositorioParametros {
  constructor(private readonly pool: Pool) {}

  /** Declara qué es un parámetro. Sin definición, un valor no se puede interpretar. */
  async definirParametro(definicion: Omit<DefinicionDeParametro, 'valores'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO parametro (nombre, descripcion, unidad) VALUES ($1,$2,$3)
         ON CONFLICT (nombre) DO UPDATE
           SET descripcion = EXCLUDED.descripcion, unidad = EXCLUDED.unidad`,
      [definicion.nombre, definicion.descripcion, definicion.unidad],
    );
  }

  /**
   * Carga un valor con su vigencia.
   *
   * La base rechaza vigencias solapadas con una restricción de exclusión, así
   * que un error de carga se detecta al cargar y no meses después, cuando un
   * cálculo tome el valor equivocado.
   */
  async cargarValor(
    parametroNombre: string,
    valor: ValorVigente,
    cargadoPor: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO parametro_valor (parametro_nombre, desde, hasta, valor, fuente, cargado_por)
         VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (parametro_nombre, desde) DO UPDATE
         SET hasta = EXCLUDED.hasta, valor = EXCLUDED.valor, fuente = EXCLUDED.fuente`,
      [parametroNombre, valor.desde, valor.hasta, valor.valor, valor.fuente, cargadoPor],
    );
  }

  /** La tabla completa, ya validada por el dominio. */
  async tablaDeParametros(): Promise<TablaDeParametros> {
    const { rows } = await this.pool.query<{
      nombre: string;
      descripcion: string;
      unidad: DefinicionDeParametro['unidad'];
      desde: string | null;
      hasta: string | null;
      valor: string | null;
      fuente: string | null;
    }>(
      `SELECT p.nombre, p.descripcion, p.unidad, v.desde, v.hasta, v.valor, v.fuente
         FROM parametro p
         LEFT JOIN parametro_valor v ON v.parametro_nombre = p.nombre
        ORDER BY p.nombre, v.desde`,
    );

    const porNombre = new Map<string, DefinicionDeParametro>();
    for (const fila of rows) {
      const existente = porNombre.get(fila.nombre);
      const valores = existente === undefined ? [] : [...existente.valores];

      if (fila.desde !== null && fila.valor !== null) {
        valores.push({
          desde: fila.desde,
          hasta: fila.hasta,
          valor: Number(fila.valor),
          fuente: fila.fuente ?? '',
        });
      }

      porNombre.set(fila.nombre, {
        nombre: fila.nombre,
        descripcion: fila.descripcion,
        unidad: fila.unidad,
        valores,
      });
    }

    // Los parámetros declarados y sin ningún valor cargado se omiten: la
    // validación del dominio los rechazaría, y declarar qué falta es
    // precisamente el estado normal de este sistema antes de que alguien cargue
    // las tablas.
    return TablaDeParametros.desde([...porNombre.values()].filter((d) => d.valores.length > 0));
  }

  /** Los parámetros declarados que todavía no tienen ningún valor cargado. */
  async parametrosSinValores(): Promise<readonly { nombre: string; descripcion: string }[]> {
    const { rows } = await this.pool.query<{ nombre: string; descripcion: string }>(
      `SELECT p.nombre, p.descripcion
         FROM parametro p
        WHERE NOT EXISTS (SELECT 1 FROM parametro_valor v WHERE v.parametro_nombre = p.nombre)
        ORDER BY p.nombre`,
    );
    return rows;
  }

  async cargarTramos(
    nombre: string,
    vigencia: TablaDeTramosVigente,
    cargadoPor: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO tabla_de_tramos (nombre, desde, hasta, unidad, tramos, fuente, cargado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (nombre, desde) DO UPDATE
         SET hasta = EXCLUDED.hasta, unidad = EXCLUDED.unidad,
             tramos = EXCLUDED.tramos, fuente = EXCLUDED.fuente`,
      [
        nombre,
        vigencia.desde,
        vigencia.hasta,
        vigencia.unidad,
        JSON.stringify(vigencia.tramos),
        vigencia.fuente,
        cargadoPor,
      ],
    );
  }

  async tablaDeTramos(nombre: string): Promise<TablaDeTramos> {
    const { rows } = await this.pool.query<{
      desde: string;
      hasta: string | null;
      unidad: TablaDeTramosVigente['unidad'];
      tramos: readonly Tramo[];
      fuente: string;
    }>(
      `SELECT desde, hasta, unidad, tramos, fuente
         FROM tabla_de_tramos WHERE nombre = $1 ORDER BY desde`,
      [nombre],
    );

    return TablaDeTramos.desde(
      nombre,
      rows.map((r) => ({
        desde: r.desde,
        hasta: r.hasta,
        unidad: r.unidad,
        tramos: r.tramos,
        fuente: r.fuente,
      })),
    );
  }

  /**
   * Guarda la liquidación entera, con su detalle.
   *
   * Una liquidación es un documento: se emitió con ciertos parámetros y
   * recalcularla después con otros daría un resultado distinto del que se pagó.
   */
  async guardarLiquidacion(empresaRut: string, liquidacion: Liquidacion): Promise<void> {
    await this.pool.query(
      `INSERT INTO liquidacion (
         empresa_rut, periodo, trabajador_id, total_imponible, total_no_imponible,
         total_haberes, total_cotizaciones_trabajador, base_tributable, impuesto_unico,
         liquido_a_pagar, costo_empleador, detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (empresa_rut, periodo, trabajador_id) DO UPDATE SET
         total_imponible = EXCLUDED.total_imponible,
         total_no_imponible = EXCLUDED.total_no_imponible,
         total_haberes = EXCLUDED.total_haberes,
         total_cotizaciones_trabajador = EXCLUDED.total_cotizaciones_trabajador,
         base_tributable = EXCLUDED.base_tributable,
         impuesto_unico = EXCLUDED.impuesto_unico,
         liquido_a_pagar = EXCLUDED.liquido_a_pagar,
         costo_empleador = EXCLUDED.costo_empleador,
         detalle = EXCLUDED.detalle`,
      [
        empresaRut,
        liquidacion.periodo,
        liquidacion.trabajadorId,
        liquidacion.totalImponible,
        liquidacion.totalNoImponible,
        liquidacion.totalHaberes,
        liquidacion.totalCotizacionesTrabajador,
        liquidacion.baseTributable,
        liquidacion.impuestoUnico,
        liquidacion.liquidoAPagar,
        liquidacion.costoEmpleador,
        JSON.stringify({
          cotizaciones: liquidacion.cotizaciones,
          aportesDelEmpleador: liquidacion.aportesDelEmpleador,
          topeImponibleAfp: liquidacion.topeImponibleAfp,
          baseTributableUtm: liquidacion.baseTributableUtm,
        }),
      ],
    );
  }

  async liquidacionesDelPeriodo(
    empresaRut: string,
    periodo: ClavePeriodo,
  ): Promise<readonly { trabajadorId: string; liquidoAPagar: number; impuestoUnico: number }[]> {
    const { rows } = await this.pool.query<{
      trabajador_id: string;
      liquido_a_pagar: string;
      impuesto_unico: string;
    }>(
      `SELECT trabajador_id, liquido_a_pagar, impuesto_unico
         FROM liquidacion WHERE empresa_rut = $1 AND periodo = $2
        ORDER BY trabajador_id`,
      [empresaRut, periodo],
    );

    return rows.map((r) => ({
      trabajadorId: r.trabajador_id,
      liquidoAPagar: Number(r.liquido_a_pagar),
      impuestoUnico: Number(r.impuesto_unico),
    }));
  }

  async clasificarCuenta(
    empresaRut: string,
    clasificacion: ClasificacionDeCuenta,
    definidaPor: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO clasificacion_de_cuenta
         (empresa_rut, cuenta_codigo, clasificacion, fundamento, definida_por)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (empresa_rut, cuenta_codigo) DO UPDATE
         SET clasificacion = EXCLUDED.clasificacion, fundamento = EXCLUDED.fundamento`,
      [
        empresaRut,
        clasificacion.cuentaCodigo,
        clasificacion.clasificacion,
        clasificacion.fundamento,
        definidaPor,
      ],
    );
  }

  async clasificaciones(empresaRut: string): Promise<readonly ClasificacionDeCuenta[]> {
    const { rows } = await this.pool.query<{
      cuenta_codigo: string;
      clasificacion: ClasificacionDeCuenta['clasificacion'];
      fundamento: string;
    }>(
      `SELECT cuenta_codigo, clasificacion, fundamento
         FROM clasificacion_de_cuenta WHERE empresa_rut = $1 ORDER BY cuenta_codigo`,
      [empresaRut],
    );

    return rows.map((r) => ({
      cuentaCodigo: r.cuenta_codigo,
      clasificacion: r.clasificacion,
      fundamento: r.fundamento,
    }));
  }
}
