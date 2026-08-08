-- Parámetros tributarios y previsionales, tramos, liquidaciones y
-- clasificación tributaria de cuentas.
--
-- Acá vive la regla central del proyecto: ningún parámetro se infiere. Todo
-- valor tiene período de vigencia y fuente, y la base impide que dos valores
-- del mismo parámetro estén vigentes a la vez.
--
-- Los valores llegan VACÍOS a propósito. Cargarlos es trabajo de quien tenga la
-- fuente autorizada; hasta entonces el sistema se niega a calcular en vez de
-- inventar.

BEGIN;

-- Permite la restricción de exclusión que impide vigencias solapadas.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE unidad_parametro AS ENUM ('pesos', 'porcentaje', 'utm', 'uf', 'codigo', 'cantidad');

CREATE TABLE parametro (
  nombre      TEXT PRIMARY KEY,
  -- En palabras de quien sabe de impuestos y no de software: es lo que va a
  -- leer quien tenga que ir a buscar el valor.
  descripcion TEXT NOT NULL,
  unidad      unidad_parametro NOT NULL,

  CONSTRAINT parametro_descripcion_no_vacia CHECK (btrim(descripcion) <> '')
);

CREATE TABLE parametro_valor (
  parametro_nombre TEXT NOT NULL REFERENCES parametro(nombre) ON DELETE CASCADE,
  desde            CHAR(6) NOT NULL,
  -- NULL significa que sigue vigente.
  hasta            CHAR(6),
  valor            NUMERIC NOT NULL,
  -- Circular, resolución, tabla de Previred, página del SII. Un valor sin
  -- fuente no se puede auditar ni actualizar con confianza.
  fuente           TEXT NOT NULL,
  cargado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cargado_por      TEXT NOT NULL,

  -- Rango semiabierto sobre el período como entero, para la exclusión de abajo.
  vigencia int4range GENERATED ALWAYS AS (
    int4range(desde::int, CASE WHEN hasta IS NULL THEN NULL ELSE hasta::int + 1 END)
  ) STORED,

  PRIMARY KEY (parametro_nombre, desde),
  CONSTRAINT parametro_valor_periodos_validos
    CHECK (desde ~ '^\d{4}(0[1-9]|1[0-2])$' AND (hasta IS NULL OR hasta ~ '^\d{4}(0[1-9]|1[0-2])$')),
  CONSTRAINT parametro_valor_rango_coherente CHECK (hasta IS NULL OR hasta >= desde),
  CONSTRAINT parametro_valor_con_fuente CHECK (btrim(fuente) <> ''),

  -- Dos valores vigentes a la vez harían que el resultado dependa del orden en
  -- que se lean, y eso cambia sin que nadie lo note.
  EXCLUDE USING gist (parametro_nombre WITH =, vigencia WITH &&)
);

-- Tablas de tramos para impuestos progresivos. Los tramos van en JSONB por la
-- misma razón que las reglas de contabilización: su forma va a crecer y
-- normalizarla ahora fijaría un vocabulario que no conocemos entero.
CREATE TABLE tabla_de_tramos (
  nombre      TEXT NOT NULL,
  desde       CHAR(6) NOT NULL,
  hasta       CHAR(6),
  unidad      unidad_parametro NOT NULL,
  tramos      JSONB NOT NULL,
  fuente      TEXT NOT NULL,
  cargado_en  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cargado_por TEXT NOT NULL,

  vigencia int4range GENERATED ALWAYS AS (
    int4range(desde::int, CASE WHEN hasta IS NULL THEN NULL ELSE hasta::int + 1 END)
  ) STORED,

  PRIMARY KEY (nombre, desde),
  CONSTRAINT tramos_con_fuente CHECK (btrim(fuente) <> ''),
  -- Un solo tramo no es una tabla progresiva; y sin al menos uno no hay nada
  -- que aplicar.
  CONSTRAINT tramos_no_vacios CHECK (jsonb_array_length(tramos) >= 1),
  EXCLUDE USING gist (nombre WITH =, vigencia WITH &&)
);

-- Liquidaciones ya calculadas. Se guardan enteras, con el detalle en JSONB,
-- porque una liquidación es un documento: se emitió con ciertos parámetros y
-- recalcularla más tarde con otros daría un resultado distinto al que se pagó.
CREATE TABLE liquidacion (
  empresa_rut                   TEXT NOT NULL REFERENCES empresa(rut),
  periodo                       CHAR(6) NOT NULL,
  trabajador_id                 TEXT NOT NULL,
  total_imponible               BIGINT NOT NULL,
  total_no_imponible            BIGINT NOT NULL,
  total_haberes                 BIGINT NOT NULL,
  total_cotizaciones_trabajador BIGINT NOT NULL,
  base_tributable               BIGINT NOT NULL,
  impuesto_unico                BIGINT NOT NULL,
  liquido_a_pagar               BIGINT NOT NULL,
  costo_empleador               BIGINT NOT NULL,
  -- Cotizaciones y aportes con su base, su tasa y el parámetro del que salió,
  -- para poder auditar cualquier cifra sin recalcular.
  detalle                       JSONB NOT NULL,
  -- Qué asiento la contabilizó. NULL mientras no llegue al mayor.
  asiento_numero                BIGINT,
  calculada_en                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (empresa_rut, periodo, trabajador_id),
  FOREIGN KEY (empresa_rut, asiento_numero) REFERENCES asiento(empresa_rut, numero),
  CONSTRAINT liquidacion_periodo_valido CHECK (periodo ~ '^\d{4}(0[1-9]|1[0-2])$'),
  CONSTRAINT liquidacion_montos_no_negativos
    CHECK (total_haberes >= 0 AND impuesto_unico >= 0 AND total_cotizaciones_trabajador >= 0),
  -- El líquido tiene que ser lo que queda: si no cuadra, la liquidación es
  -- internamente incoherente y no debe poder guardarse.
  CONSTRAINT liquidacion_cuadra
    CHECK (liquido_a_pagar = total_haberes - total_cotizaciones_trabajador - impuesto_unico)
);

CREATE TYPE clasificacion_tributaria AS ENUM ('aceptado', 'gasto_rechazado', 'ingreso_no_renta');

-- Cómo trata la ley a cada cuenta de resultado. No se deduce del nombre:
-- "Multas" suena a gasto rechazado y "Asesorías" no, pero depende del caso.
CREATE TABLE clasificacion_de_cuenta (
  empresa_rut   TEXT NOT NULL,
  cuenta_codigo TEXT NOT NULL,
  clasificacion clasificacion_tributaria NOT NULL,
  -- Artículo, oficio o criterio del contador. Sin fundamento la clasificación
  -- no se puede defender en una fiscalización.
  fundamento    TEXT NOT NULL,
  definida_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  definida_por  TEXT NOT NULL,

  PRIMARY KEY (empresa_rut, cuenta_codigo),
  FOREIGN KEY (empresa_rut, cuenta_codigo) REFERENCES cuenta(empresa_rut, codigo),
  CONSTRAINT clasificacion_con_fundamento CHECK (btrim(fundamento) <> '')
);

COMMIT;
