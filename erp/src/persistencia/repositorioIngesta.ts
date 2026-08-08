/**
 * Persistencia de la ingesta: documentos traídos del SII y reglas de
 * contabilización.
 *
 * Mismas dos condiciones que el repositorio contable: todo parametrizado y todo
 * filtrado por empresa.
 */
import { type Pool } from 'pg';

import { type DocumentoIngestado, claveDeIdempotencia } from '../ingesta/documento';
import { type DocumentoRegistrado } from '../ingesta/conciliacion';
import { type Regla } from '../ingesta/reglas';
import { type FechaContable } from '../dominio/periodos';

function aFechaContable(valor: Date | string): FechaContable {
  if (typeof valor === 'string') return valor.slice(0, 10);
  const anio = valor.getFullYear();
  const mes = String(valor.getMonth() + 1).padStart(2, '0');
  const dia = String(valor.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}

export class RepositorioIngesta {
  constructor(private readonly pool: Pool) {}

  /**
   * Guarda el documento. Si ya estaba, actualiza sus montos — el SII corrige
   * documentos, y la conciliación ya decidió que este cambio se acepta.
   *
   * No toca `asiento_numero`: qué asiento lo contabilizó no lo decide la
   * ingesta, y pisarlo con NULL desharía el vínculo con el mayor.
   */
  async guardarDocumento(documento: DocumentoIngestado): Promise<string> {
    const clave = claveDeIdempotencia(documento);

    await this.pool.query(
      `INSERT INTO documento_ingestado (
         empresa_rut, clave, operacion, tipo_doc_codigo, folio, fecha,
         contraparte_rut, contraparte_tipo_id, contraparte_id_extranjero, contraparte_nombre,
         monto_neto, monto_exento, monto_iva, monto_total,
         referencia_tipo_doc, referencia_folio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (empresa_rut, clave) DO UPDATE SET
         monto_neto   = EXCLUDED.monto_neto,
         monto_exento = EXCLUDED.monto_exento,
         monto_iva    = EXCLUDED.monto_iva,
         monto_total  = EXCLUDED.monto_total,
         fecha        = EXCLUDED.fecha`,
      [
        documento.empresaRut,
        clave,
        documento.operacion,
        documento.tipoDocCodigo,
        documento.folio,
        documento.fecha,
        documento.contraparteRut,
        documento.contraparteTipoId,
        documento.contraparteIdExtranjero ?? null,
        documento.contraparteNombre,
        documento.montoNeto,
        documento.montoExento,
        documento.montoIva,
        documento.montoTotal,
        documento.referenciaTipoDoc ?? null,
        documento.referenciaFolio ?? null,
      ],
    );

    return clave;
  }

  /** Lo ya registrado, para que la conciliación sepa qué es nuevo. */
  async documentosRegistrados(
    empresaRut: string,
    rango: { desde?: FechaContable; hasta?: FechaContable } = {},
  ): Promise<readonly DocumentoRegistrado[]> {
    const { rows } = await this.pool.query<{
      clave: string;
      monto_neto: string;
      monto_exento: string;
      monto_iva: string;
      monto_total: string;
      asiento_numero: string | null;
    }>(
      `SELECT clave, monto_neto, monto_exento, monto_iva, monto_total, asiento_numero
         FROM documento_ingestado
        WHERE empresa_rut = $1
          AND ($2::date IS NULL OR fecha >= $2::date)
          AND ($3::date IS NULL OR fecha <= $3::date)`,
      [empresaRut, rango.desde ?? null, rango.hasta ?? null],
    );

    return rows.map((r) => ({
      clave: r.clave,
      montoNeto: Number(r.monto_neto),
      montoExento: Number(r.monto_exento),
      montoIva: Number(r.monto_iva),
      montoTotal: Number(r.monto_total),
      ...(r.asiento_numero !== null ? { asientoNumero: Number(r.asiento_numero) } : {}),
    }));
  }

  /** Vincula el documento con el asiento que lo contabilizó. */
  async marcarContabilizado(
    empresaRut: string,
    clave: string,
    asientoNumero: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE documento_ingestado SET asiento_numero = $3
         WHERE empresa_rut = $1 AND clave = $2`,
      [empresaRut, clave, asientoNumero],
    );
  }

  /** Los ingestados que todavía no llegaron al mayor. Es la bandeja de pendientes. */
  async documentosSinContabilizar(
    empresaRut: string,
  ): Promise<readonly { clave: string; fecha: FechaContable; glosa: string }[]> {
    const { rows } = await this.pool.query<{
      clave: string;
      fecha: Date;
      contraparte_nombre: string;
      tipo_doc_codigo: number;
      folio: string;
    }>(
      `SELECT clave, fecha, contraparte_nombre, tipo_doc_codigo, folio
         FROM documento_ingestado
        WHERE empresa_rut = $1 AND asiento_numero IS NULL
        ORDER BY fecha, folio`,
      [empresaRut],
    );

    return rows.map((r) => ({
      clave: r.clave,
      fecha: aFechaContable(r.fecha),
      glosa: `${r.contraparte_nombre} — documento ${r.tipo_doc_codigo} folio ${r.folio}`,
    }));
  }

  async guardarRegla(empresaRut: string, regla: Regla, creadaPor: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO regla_contabilizacion
         (id, empresa_rut, nombre, prioridad, activa, condicion, lineas, creada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (empresa_rut, id) DO UPDATE SET
         nombre    = EXCLUDED.nombre,
         prioridad = EXCLUDED.prioridad,
         activa    = EXCLUDED.activa,
         condicion = EXCLUDED.condicion,
         lineas    = EXCLUDED.lineas`,
      [
        regla.id,
        empresaRut,
        regla.nombre,
        regla.prioridad,
        regla.activa,
        JSON.stringify(regla.condicion),
        JSON.stringify(regla.lineas),
        creadaPor,
      ],
    );
  }

  async reglas(empresaRut: string): Promise<readonly Regla[]> {
    const { rows } = await this.pool.query<{
      id: string;
      nombre: string;
      prioridad: number;
      activa: boolean;
      condicion: Regla['condicion'];
      lineas: Regla['lineas'];
    }>(
      `SELECT id, nombre, prioridad, activa, condicion, lineas
         FROM regla_contabilizacion WHERE empresa_rut = $1 ORDER BY prioridad DESC, id`,
      [empresaRut],
    );

    return rows.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      prioridad: r.prioridad,
      activa: r.activa,
      condicion: r.condicion,
      lineas: r.lineas,
    }));
  }
}
