/**
 * Persistencia del núcleo contable sobre Postgres.
 *
 * Todas las consultas van parametrizadas. Interpolar valores en el SQL de un
 * libro contable sería entregar las llaves del mayor a cualquiera que controle
 * una glosa o una referencia.
 *
 * Toda consulta filtra por empresa. La empresa es columna, no supuesto: es la
 * única forma de que agregar la segunda no obligue a revisar cada consulta.
 */
import { type Pool, type PoolClient } from 'pg';

import { type Asiento, type Borrador, type LineaAsiento, aprobar } from '../dominio/asiento';
import { type Cuenta, PlanDeCuentas } from '../dominio/cuentas';
import { Calendario, type ClavePeriodo, type FechaContable, type Periodo } from '../dominio/periodos';

/** Una fecha de Postgres llega como `Date`; la volvemos a `AAAA-MM-DD` sin pasar por la zona horaria. */
function aFechaContable(valor: Date | string): FechaContable {
  if (typeof valor === 'string') return valor.slice(0, 10);
  const anio = valor.getFullYear();
  const mes = String(valor.getMonth() + 1).padStart(2, '0');
  const dia = String(valor.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

export class BorradorNoEncontrado extends Error {
  constructor(readonly id: string) {
    super(`No existe el borrador ${id}`);
    this.name = 'BorradorNoEncontrado';
  }
}

export class RepositorioContable {
  constructor(private readonly pool: Pool) {}

  async planDeCuentas(empresaRut: string): Promise<PlanDeCuentas> {
    const { rows } = await this.pool.query<{
      codigo: string;
      nombre: string;
      tipo: Cuenta['tipo'];
      padre_codigo: string | null;
      activa: boolean;
    }>(
      `SELECT codigo, nombre, tipo, padre_codigo, activa
         FROM cuenta WHERE empresa_rut = $1 ORDER BY codigo`,
      [empresaRut],
    );

    return PlanDeCuentas.desde(
      rows.map((r) => ({
        codigo: r.codigo,
        nombre: r.nombre,
        tipo: r.tipo,
        padreCodigo: r.padre_codigo,
        activa: r.activa,
      })),
    );
  }

  async calendario(empresaRut: string): Promise<Calendario> {
    const { rows } = await this.pool.query<{ clave: string; estado: Periodo['estado'] }>(
      `SELECT clave, estado FROM periodo WHERE empresa_rut = $1 ORDER BY clave`,
      [empresaRut],
    );
    return new Calendario(rows.map((r) => ({ clave: r.clave, estado: r.estado })));
  }

  async abrirPeriodo(empresaRut: string, clave: ClavePeriodo): Promise<void> {
    await this.pool.query(
      `INSERT INTO periodo (empresa_rut, clave, estado) VALUES ($1, $2, 'abierto')
         ON CONFLICT (empresa_rut, clave) DO NOTHING`,
      [empresaRut, clave],
    );
  }

  async cerrarPeriodo(empresaRut: string, clave: ClavePeriodo, actor: string): Promise<void> {
    // Delegamos en el calendario del dominio para que la regla de reapertura y
    // la de existencia sean las mismas en memoria y contra la base.
    const calendario = await this.calendario(empresaRut);
    calendario.cerrar(clave); // lanza si no existe

    await this.pool.query(
      `UPDATE periodo SET estado = 'cerrado', cerrado_en = now(), cerrado_por = $3
         WHERE empresa_rut = $1 AND clave = $2`,
      [empresaRut, clave, actor],
    );
  }

  async reabrirPeriodo(empresaRut: string, clave: ClavePeriodo): Promise<void> {
    const calendario = await this.calendario(empresaRut);
    calendario.reabrir(clave); // lanza si hay cierres posteriores

    await this.pool.query(
      `UPDATE periodo SET estado = 'abierto', cerrado_en = NULL, cerrado_por = NULL
         WHERE empresa_rut = $1 AND clave = $2`,
      [empresaRut, clave],
    );
  }

  async guardarBorrador(borrador: Borrador, propuestoPor: string): Promise<void> {
    await this.enTransaccion(async (cliente) => {
      await cliente.query(
        `INSERT INTO borrador (id, empresa_rut, fecha, glosa, origen, referencia, propuesto_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE
           SET fecha = EXCLUDED.fecha, glosa = EXCLUDED.glosa,
               origen = EXCLUDED.origen, referencia = EXCLUDED.referencia`,
        [
          borrador.id,
          borrador.empresaRut,
          borrador.fecha,
          borrador.glosa,
          borrador.origen,
          borrador.referencia ?? null,
          propuestoPor,
        ],
      );

      // Un borrador se edita entero: reemplazar las líneas es más simple y más
      // seguro que reconciliarlas, y no hay historia que preservar porque el
      // borrador todavía no es contabilidad.
      await cliente.query(`DELETE FROM linea_borrador WHERE borrador_id = $1`, [borrador.id]);

      for (const [indice, linea] of borrador.lineas.entries()) {
        await cliente.query(
          `INSERT INTO linea_borrador (borrador_id, numero_linea, cuenta_codigo, debe, haber, glosa)
             VALUES ($1, $2, $3, $4, $5, $6)`,
          [borrador.id, indice + 1, linea.cuentaCodigo, linea.debe, linea.haber, linea.glosa ?? null],
        );
      }

      await this.auditar(cliente, {
        empresaRut: borrador.empresaRut,
        actor: propuestoPor,
        accion: 'borrador.guardado',
        borradorId: borrador.id,
        detalle: { origen: borrador.origen, lineas: borrador.lineas.length },
      });
    });
  }

  async borrador(empresaRut: string, id: string): Promise<Borrador> {
    const { rows } = await this.pool.query<{
      id: string;
      empresa_rut: string;
      fecha: Date;
      glosa: string;
      origen: Borrador['origen'];
      referencia: string | null;
    }>(
      `SELECT id, empresa_rut, fecha, glosa, origen, referencia
         FROM borrador WHERE empresa_rut = $1 AND id = $2`,
      [empresaRut, id],
    );

    const cabecera = rows[0];
    if (cabecera === undefined) throw new BorradorNoEncontrado(id);

    const { rows: lineas } = await this.pool.query<{
      cuenta_codigo: string;
      debe: string;
      haber: string;
      glosa: string | null;
    }>(
      `SELECT cuenta_codigo, debe, haber, glosa
         FROM linea_borrador WHERE borrador_id = $1 ORDER BY numero_linea`,
      [id],
    );

    return {
      id: cabecera.id,
      empresaRut: cabecera.empresa_rut,
      fecha: aFechaContable(cabecera.fecha),
      glosa: cabecera.glosa,
      origen: cabecera.origen,
      ...(cabecera.referencia !== null ? { referencia: cabecera.referencia } : {}),
      lineas: lineas.map(aLinea),
    };
  }

  async descartarBorrador(empresaRut: string, id: string, actor: string, motivo: string): Promise<void> {
    await this.enTransaccion(async (cliente) => {
      const { rowCount } = await cliente.query(
        `DELETE FROM borrador WHERE empresa_rut = $1 AND id = $2`,
        [empresaRut, id],
      );
      if (rowCount === 0) throw new BorradorNoEncontrado(id);

      // El contenido del borrador no es contabilidad, pero importa saber que
      // alguien propuso algo y que alguien más lo rechazó.
      await this.auditar(cliente, {
        empresaRut,
        actor,
        accion: 'borrador.descartado',
        borradorId: id,
        detalle: { motivo },
      });
    });
  }

  /**
   * Aprueba un borrador y lo convierte en asiento. Es el único camino al mayor.
   *
   * Todo ocurre en una transacción: el correlativo se asigna bajo un bloqueo de
   * transacción, y el cuadre lo verifica un disparador diferido al COMMIT. Si
   * algo falla, no queda ni el asiento ni el hueco en la numeración.
   */
  async aprobarBorrador(
    empresaRut: string,
    borradorId: string,
    aprobadoPor: string,
    revierteNumero?: number,
  ): Promise<Asiento> {
    const borrador = await this.borrador(empresaRut, borradorId);
    const plan = await this.planDeCuentas(empresaRut);
    const calendario = await this.calendario(empresaRut);

    return this.enTransaccion(async (cliente) => {
      const { rows } = await cliente.query<{ numero: string }>(
        `SELECT siguiente_numero_de_asiento($1) AS numero`,
        [empresaRut],
      );
      const numero = Number((rows[0] as { numero: string }).numero);

      // Validar en el dominio antes de escribir da el detalle de todos los
      // problemas juntos; la base sólo diría el primero que rompe.
      const asiento = aprobar(borrador, plan, calendario, {
        numero,
        aprobadoPor,
        aprobadoEn: new Date().toISOString(),
        ...(revierteNumero !== undefined ? { revierteNumero } : {}),
      });

      await cliente.query(
        `INSERT INTO asiento
           (empresa_rut, numero, fecha, glosa, origen, referencia, desde_borrador, aprobado_por, revierte_numero)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          empresaRut,
          numero,
          asiento.fecha,
          asiento.glosa,
          asiento.origen,
          asiento.referencia ?? null,
          borradorId,
          aprobadoPor,
          revierteNumero ?? null,
        ],
      );

      for (const [indice, linea] of asiento.lineas.entries()) {
        await cliente.query(
          `INSERT INTO linea_asiento
             (empresa_rut, asiento_numero, numero_linea, cuenta_codigo, debe, haber, glosa)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [empresaRut, numero, indice + 1, linea.cuentaCodigo, linea.debe, linea.haber, linea.glosa ?? null],
        );
      }

      await cliente.query(`DELETE FROM borrador WHERE empresa_rut = $1 AND id = $2`, [
        empresaRut,
        borradorId,
      ]);

      await this.auditar(cliente, {
        empresaRut,
        actor: aprobadoPor,
        accion: 'asiento.aprobado',
        borradorId,
        asientoNumero: numero,
        detalle: { origen: asiento.origen, ...(revierteNumero !== undefined ? { revierteNumero } : {}) },
      });

      return asiento;
    });
  }

  /** Los asientos aprobados, para alimentar el mayor y los estados financieros. */
  async asientos(
    empresaRut: string,
    rango: { desde?: FechaContable; hasta?: FechaContable } = {},
  ): Promise<readonly Asiento[]> {
    const { rows } = await this.pool.query<{
      numero: string;
      fecha: Date;
      glosa: string;
      origen: Asiento['origen'];
      referencia: string | null;
      aprobado_por: string;
      aprobado_en: Date;
      revierte_numero: string | null;
    }>(
      `SELECT numero, fecha, glosa, origen, referencia, aprobado_por, aprobado_en, revierte_numero
         FROM asiento
        WHERE empresa_rut = $1
          AND ($2::date IS NULL OR fecha >= $2::date)
          AND ($3::date IS NULL OR fecha <= $3::date)
        ORDER BY fecha, numero`,
      [empresaRut, rango.desde ?? null, rango.hasta ?? null],
    );

    if (rows.length === 0) return [];

    const numeros = rows.map((r) => Number(r.numero));
    const { rows: lineas } = await this.pool.query<{
      asiento_numero: string;
      cuenta_codigo: string;
      debe: string;
      haber: string;
      glosa: string | null;
    }>(
      `SELECT asiento_numero, cuenta_codigo, debe, haber, glosa
         FROM linea_asiento
        WHERE empresa_rut = $1 AND asiento_numero = ANY($2::bigint[])
        ORDER BY asiento_numero, numero_linea`,
      [empresaRut, numeros],
    );

    const porAsiento = new Map<number, LineaAsiento[]>();
    for (const l of lineas) {
      const numero = Number(l.asiento_numero);
      const acumuladas = porAsiento.get(numero) ?? [];
      acumuladas.push(aLinea(l));
      porAsiento.set(numero, acumuladas);
    }

    return rows.map((r) => {
      const numero = Number(r.numero);
      return Object.freeze({
        id: `asiento-${numero}`,
        empresaRut,
        numero,
        fecha: aFechaContable(r.fecha),
        glosa: r.glosa,
        origen: r.origen,
        ...(r.referencia !== null ? { referencia: r.referencia } : {}),
        aprobadoPor: r.aprobado_por,
        aprobadoEn: r.aprobado_en.toISOString(),
        ...(r.revierte_numero !== null ? { revierteNumero: Number(r.revierte_numero) } : {}),
        lineas: Object.freeze(porAsiento.get(numero) ?? []),
      });
    });
  }

  private async auditar(
    cliente: PoolClient,
    evento: {
      empresaRut: string;
      actor: string;
      accion: string;
      borradorId?: string;
      asientoNumero?: number;
      detalle: Record<string, unknown>;
    },
  ): Promise<void> {
    await cliente.query(
      `INSERT INTO evento_auditoria (empresa_rut, actor, accion, borrador_id, asiento_numero, detalle)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        evento.empresaRut,
        evento.actor,
        evento.accion,
        evento.borradorId ?? null,
        evento.asientoNumero ?? null,
        JSON.stringify(evento.detalle),
      ],
    );
  }

  private async enTransaccion<T>(fn: (cliente: PoolClient) => Promise<T>): Promise<T> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('BEGIN');
      const resultado = await fn(cliente);
      // El disparador del cuadre está diferido: si el asiento no cuadra, es acá
      // donde falla, no en el INSERT.
      await cliente.query('COMMIT');
      return resultado;
    } catch (error) {
      await cliente.query('ROLLBACK');
      throw error;
    } finally {
      cliente.release();
    }
  }
}

/** Postgres devuelve BIGINT como cadena para no perder precisión; acá caben en un entero seguro. */
function aLinea(fila: {
  cuenta_codigo: string;
  debe: string;
  haber: string;
  glosa: string | null;
}): LineaAsiento {
  return {
    cuentaCodigo: fila.cuenta_codigo,
    debe: Number(fila.debe),
    haber: Number(fila.haber),
    ...(fila.glosa !== null ? { glosa: fila.glosa } : {}),
  };
}
