-- Ingesta: documentos traídos del SII y reglas de contabilización.
--
-- Los documentos se guardan para que reingestar un período sea seguro, que es
-- la operación normal cuando el SII incorpora documentos con atraso. La clave
-- de idempotencia es la primaria: si el mismo documento llega dos veces, la
-- base lo dice en vez de duplicarlo.

BEGIN;

CREATE TYPE operacion_documento AS ENUM ('compra', 'venta');
CREATE TYPE tipo_id_contraparte AS ENUM ('rut_chileno', 'extranjero');

CREATE TABLE documento_ingestado (
  empresa_rut               TEXT NOT NULL REFERENCES empresa(rut),
  -- La calcula el dominio: incluye el discriminador de contraparte extranjera,
  -- sin el cual dos proveedores distintos con el mismo folio se fusionarían.
  clave                     TEXT NOT NULL,
  operacion                 operacion_documento NOT NULL,
  tipo_doc_codigo           INT NOT NULL,
  folio                     TEXT NOT NULL,
  fecha                     DATE NOT NULL,
  contraparte_rut           TEXT NOT NULL,
  contraparte_tipo_id       tipo_id_contraparte NOT NULL,
  contraparte_id_extranjero TEXT,
  contraparte_nombre        TEXT NOT NULL,
  monto_neto                BIGINT NOT NULL,
  monto_exento              BIGINT NOT NULL,
  monto_iva                 BIGINT NOT NULL,
  monto_total               BIGINT NOT NULL,
  referencia_tipo_doc       INT,
  referencia_folio          TEXT,
  -- Qué asiento lo contabilizó. NULL mientras siga en la bandeja: un documento
  -- ingestado y no contabilizado es un pendiente, no un error.
  asiento_numero            BIGINT,
  ingestado_en              TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (empresa_rut, clave),
  FOREIGN KEY (empresa_rut, asiento_numero) REFERENCES asiento(empresa_rut, numero),
  CONSTRAINT documento_montos_no_negativos
    CHECK (monto_neto >= 0 AND monto_exento >= 0 AND monto_iva >= 0 AND monto_total >= 0),
  -- Un extranjero sin ningún discriminador no debería haber llegado hasta acá:
  -- el dominio lo aparta como ambiguo. La restricción es la segunda barrera.
  CONSTRAINT documento_extranjero_distinguible
    CHECK (
      contraparte_tipo_id = 'rut_chileno'
      OR btrim(coalesce(contraparte_id_extranjero, '')) <> ''
      OR btrim(contraparte_nombre) <> ''
    )
);

CREATE INDEX documento_por_periodo
  ON documento_ingestado (empresa_rut, fecha);
CREATE INDEX documento_sin_contabilizar
  ON documento_ingestado (empresa_rut) WHERE asiento_numero IS NULL;

-- Las reglas son datos: se editan desde la interfaz y nacen de propuestas del
-- agente que alguien aprobó. La condición y las líneas van en JSONB porque su
-- forma va a crecer, y normalizarlas ahora fijaría un vocabulario que todavía
-- no conocemos entero.
CREATE TABLE regla_contabilizacion (
  id          TEXT NOT NULL,
  empresa_rut TEXT NOT NULL REFERENCES empresa(rut),
  nombre      TEXT NOT NULL,
  prioridad   INT NOT NULL DEFAULT 0,
  activa      BOOLEAN NOT NULL DEFAULT true,
  condicion   JSONB NOT NULL DEFAULT '{}'::jsonb,
  lineas      JSONB NOT NULL,
  creada_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  creada_por  TEXT NOT NULL,
  -- Si nació de una propuesta del agente, cuál fue.
  desde_borrador UUID,

  PRIMARY KEY (empresa_rut, id),
  CONSTRAINT regla_nombre_no_vacio CHECK (btrim(nombre) <> ''),
  -- Una regla necesita al menos dos líneas o no puede producir un asiento.
  CONSTRAINT regla_tiene_lineas CHECK (jsonb_array_length(lineas) >= 2)
);

COMMIT;
