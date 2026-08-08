-- Núcleo contable: plan de cuentas, períodos, borradores, asientos y auditoría.
--
-- Las invariantes de la partida doble están acá y no sólo en la aplicación.
-- Un asiento descuadrado no debe poder existir en la base aunque la aplicación
-- tenga un bug: es la invariante que hace que todos los reportes signifiquen
-- algo, y los reportes derivan de estas filas.
--
-- Los montos son BIGINT en pesos. Sin decimales, sin punto flotante.

BEGIN;

CREATE TABLE empresa (
  rut              TEXT PRIMARY KEY,
  razon_social     TEXT NOT NULL,
  -- Primer día del primer ejercicio con contabilidad en este sistema.
  inicio_ejercicio DATE NOT NULL,
  creada_en        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE tipo_cuenta AS ENUM ('activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto');

CREATE TABLE cuenta (
  empresa_rut  TEXT NOT NULL REFERENCES empresa(rut),
  codigo       TEXT NOT NULL,
  nombre       TEXT NOT NULL,
  tipo         tipo_cuenta NOT NULL,
  padre_codigo TEXT,
  activa       BOOLEAN NOT NULL DEFAULT true,

  PRIMARY KEY (empresa_rut, codigo),
  FOREIGN KEY (empresa_rut, padre_codigo) REFERENCES cuenta(empresa_rut, codigo),
  CONSTRAINT cuenta_no_es_su_propio_padre CHECK (padre_codigo IS DISTINCT FROM codigo),
  CONSTRAINT cuenta_codigo_no_vacio CHECK (btrim(codigo) <> '')
);

CREATE INDEX cuenta_por_padre ON cuenta (empresa_rut, padre_codigo);

-- Una hija de otro tipo que su padre haría que el subtotal del padre mezclara
-- naturalezas y que la cuenta apareciera en el estado equivocado.
CREATE FUNCTION cuenta_hereda_tipo_del_padre() RETURNS TRIGGER AS $$
DECLARE
  tipo_padre tipo_cuenta;
BEGIN
  IF NEW.padre_codigo IS NULL THEN RETURN NEW; END IF;

  SELECT tipo INTO tipo_padre
    FROM cuenta
   WHERE empresa_rut = NEW.empresa_rut AND codigo = NEW.padre_codigo;

  IF tipo_padre IS DISTINCT FROM NEW.tipo THEN
    RAISE EXCEPTION
      'La cuenta % es % pero su padre % es %',
      NEW.codigo, NEW.tipo, NEW.padre_codigo, tipo_padre;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cuenta_tipo_coherente
  BEFORE INSERT OR UPDATE ON cuenta
  FOR EACH ROW EXECUTE FUNCTION cuenta_hereda_tipo_del_padre();

-- Cambiar el tipo de una cuenta con movimientos cambia retroactivamente los
-- estados financieros ya emitidos. Se crea una cuenta nueva y se traspasa el
-- saldo con un asiento.
CREATE FUNCTION cuenta_tipo_inmutable_con_movimientos() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tipo IS DISTINCT FROM OLD.tipo
     AND EXISTS (
       SELECT 1 FROM linea_asiento
        WHERE empresa_rut = OLD.empresa_rut AND cuenta_codigo = OLD.codigo
     )
  THEN
    RAISE EXCEPTION
      'No se puede cambiar el tipo de la cuenta % porque ya tiene movimientos. '
      'Creá una cuenta nueva y traspasá el saldo con un asiento.', OLD.codigo;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TYPE estado_periodo AS ENUM ('abierto', 'cerrado');

CREATE TABLE periodo (
  empresa_rut TEXT NOT NULL REFERENCES empresa(rut),
  clave       CHAR(6) NOT NULL,  -- AAAAMM, el mismo formato que usa el SII
  estado      estado_periodo NOT NULL DEFAULT 'abierto',
  cerrado_en  TIMESTAMPTZ,
  cerrado_por TEXT,

  PRIMARY KEY (empresa_rut, clave),
  CONSTRAINT periodo_clave_valida CHECK (clave ~ '^\d{4}(0[1-9]|1[0-2])$'),
  CONSTRAINT periodo_cerrado_tiene_responsable
    CHECK (estado = 'abierto' OR (cerrado_en IS NOT NULL AND cerrado_por IS NOT NULL))
);

CREATE TYPE origen_asiento AS ENUM ('manual', 'regla', 'agente', 'apertura', 'cierre');

-- Los borradores no son contabilidad: se editan y se descartan libremente y no
-- tocan el mayor. Por eso viven en su propia tabla, sin las restricciones de
-- inmutabilidad ni el correlativo.
CREATE TABLE borrador (
  id           UUID PRIMARY KEY,
  empresa_rut  TEXT NOT NULL REFERENCES empresa(rut),
  fecha        DATE NOT NULL,
  glosa        TEXT NOT NULL,
  origen       origen_asiento NOT NULL,
  referencia   TEXT,
  propuesto_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  propuesto_por TEXT NOT NULL
);

CREATE TABLE linea_borrador (
  borrador_id   UUID NOT NULL REFERENCES borrador(id) ON DELETE CASCADE,
  numero_linea  INT NOT NULL,
  cuenta_codigo TEXT NOT NULL,
  debe          BIGINT NOT NULL DEFAULT 0,
  haber         BIGINT NOT NULL DEFAULT 0,
  glosa         TEXT,

  PRIMARY KEY (borrador_id, numero_linea),
  CONSTRAINT linea_borrador_montos_no_negativos CHECK (debe >= 0 AND haber >= 0)
);

CREATE TABLE asiento (
  empresa_rut     TEXT NOT NULL REFERENCES empresa(rut),
  numero          BIGINT NOT NULL,
  fecha           DATE NOT NULL,
  glosa           TEXT NOT NULL,
  origen          origen_asiento NOT NULL,
  referencia      TEXT,
  desde_borrador  UUID,
  aprobado_por    TEXT NOT NULL,
  aprobado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revierte_numero BIGINT,

  PRIMARY KEY (empresa_rut, numero),
  FOREIGN KEY (empresa_rut, revierte_numero) REFERENCES asiento(empresa_rut, numero),
  CONSTRAINT asiento_glosa_no_vacia CHECK (btrim(glosa) <> ''),
  CONSTRAINT asiento_no_se_revierte_a_si_mismo CHECK (revierte_numero IS DISTINCT FROM numero)
);

CREATE INDEX asiento_por_fecha ON asiento (empresa_rut, fecha, numero);

CREATE TABLE linea_asiento (
  empresa_rut    TEXT NOT NULL,
  asiento_numero BIGINT NOT NULL,
  numero_linea   INT NOT NULL,
  cuenta_codigo  TEXT NOT NULL,
  debe           BIGINT NOT NULL DEFAULT 0,
  haber          BIGINT NOT NULL DEFAULT 0,
  glosa          TEXT,

  PRIMARY KEY (empresa_rut, asiento_numero, numero_linea),
  FOREIGN KEY (empresa_rut, asiento_numero) REFERENCES asiento(empresa_rut, numero),
  FOREIGN KEY (empresa_rut, cuenta_codigo) REFERENCES cuenta(empresa_rut, codigo),

  -- Una línea carga o abona, no las dos: si no, el neto queda oculto dentro
  -- de la línea y el mayor deja de ser legible.
  CONSTRAINT linea_no_en_ambas_columnas CHECK (debe = 0 OR haber = 0),
  CONSTRAINT linea_mueve_algo CHECK (debe > 0 OR haber > 0),
  CONSTRAINT linea_montos_no_negativos CHECK (debe >= 0 AND haber >= 0)
);

CREATE INDEX linea_asiento_por_cuenta ON linea_asiento (empresa_rut, cuenta_codigo);

CREATE TRIGGER cuenta_tipo_no_cambia_con_movimientos
  BEFORE UPDATE ON cuenta
  FOR EACH ROW EXECUTE FUNCTION cuenta_tipo_inmutable_con_movimientos();

-- Sólo las hojas reciben movimientos: una cuenta con hijas tendría un saldo en
-- parte propio y en parte agregado, y ningún reporte podría separarlos.
CREATE FUNCTION linea_exige_cuenta_hoja_activa() RETURNS TRIGGER AS $$
DECLARE
  esta_activa BOOLEAN;
  tiene_hijas BOOLEAN;
BEGIN
  SELECT activa INTO esta_activa
    FROM cuenta
   WHERE empresa_rut = NEW.empresa_rut AND codigo = NEW.cuenta_codigo;

  SELECT EXISTS (
    SELECT 1 FROM cuenta
     WHERE empresa_rut = NEW.empresa_rut AND padre_codigo = NEW.cuenta_codigo
  ) INTO tiene_hijas;

  IF tiene_hijas THEN
    RAISE EXCEPTION
      'La cuenta % tiene cuentas hijas y no recibe movimientos directos', NEW.cuenta_codigo;
  END IF;

  IF NOT esta_activa THEN
    RAISE EXCEPTION 'La cuenta % está inactiva', NEW.cuenta_codigo;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER linea_cuenta_hoja_activa
  BEFORE INSERT ON linea_asiento
  FOR EACH ROW EXECUTE FUNCTION linea_exige_cuenta_hoja_activa();

-- La fecha del asiento tiene que caer en un período declarado y abierto.
CREATE FUNCTION asiento_exige_periodo_abierto() RETURNS TRIGGER AS $$
DECLARE
  clave_periodo CHAR(6) := to_char(NEW.fecha, 'YYYYMM');
  estado_actual estado_periodo;
BEGIN
  SELECT estado INTO estado_actual
    FROM periodo
   WHERE empresa_rut = NEW.empresa_rut AND clave = clave_periodo;

  IF estado_actual IS NULL THEN
    RAISE EXCEPTION
      'El período % no existe en el calendario contable de %',
      clave_periodo, NEW.empresa_rut;
  END IF;

  IF estado_actual = 'cerrado' THEN
    RAISE EXCEPTION 'El período % está cerrado y no admite asientos nuevos', clave_periodo;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asiento_periodo_abierto
  BEFORE INSERT ON asiento
  FOR EACH ROW EXECUTE FUNCTION asiento_exige_periodo_abierto();

-- La invariante central. Diferida hasta el COMMIT porque las líneas se
-- insertan de a una: verificarla por fila haría imposible insertar la primera.
CREATE FUNCTION asiento_debe_cuadrar() RETURNS TRIGGER AS $$
DECLARE
  suma_debe  BIGINT;
  suma_haber BIGINT;
  cantidad   INT;
BEGIN
  SELECT COALESCE(sum(debe), 0), COALESCE(sum(haber), 0), count(*)
    INTO suma_debe, suma_haber, cantidad
    FROM linea_asiento
   WHERE empresa_rut = NEW.empresa_rut AND asiento_numero = NEW.asiento_numero;

  IF cantidad < 2 THEN
    RAISE EXCEPTION
      'El asiento % necesita al menos dos líneas; tiene %', NEW.asiento_numero, cantidad;
  END IF;

  IF suma_debe <> suma_haber THEN
    RAISE EXCEPTION
      'El asiento % no cuadra: debe %, haber %, diferencia %',
      NEW.asiento_numero, suma_debe, suma_haber, suma_debe - suma_haber;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER linea_asiento_cuadra
  AFTER INSERT ON linea_asiento
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION asiento_debe_cuadrar();

-- El mayor es append-only. Un asiento aprobado se corrige con una reversión
-- que lo referencia, nunca editándolo ni borrándolo.
CREATE FUNCTION el_mayor_no_se_edita() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Los asientos aprobados no se modifican ni se borran. '
    'Para corregir, registrá un asiento de reversión que referencie al original.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asiento_inmutable
  BEFORE UPDATE OR DELETE ON asiento
  FOR EACH ROW EXECUTE FUNCTION el_mayor_no_se_edita();

CREATE TRIGGER linea_asiento_inmutable
  BEFORE UPDATE OR DELETE ON linea_asiento
  FOR EACH ROW EXECUTE FUNCTION el_mayor_no_se_edita();

-- El correlativo es por empresa y sin huecos: un salto en la numeración del
-- libro diario es un hallazgo en una fiscalización.
CREATE FUNCTION siguiente_numero_de_asiento(p_empresa_rut TEXT) RETURNS BIGINT AS $$
DECLARE
  siguiente BIGINT;
BEGIN
  -- El bloqueo serializa la asignación: dos aprobaciones simultáneas tomarían
  -- el mismo número si sólo leyeran el máximo.
  PERFORM pg_advisory_xact_lock(hashtext('asiento:' || p_empresa_rut));

  SELECT COALESCE(max(numero), 0) + 1 INTO siguiente
    FROM asiento WHERE empresa_rut = p_empresa_rut;

  RETURN siguiente;
END;
$$ LANGUAGE plpgsql;

-- Auditoría de todo lo que le pasa a un borrador y a un asiento. El contenido
-- del borrador no es contabilidad, pero importa saber que el agente propuso
-- algo y que alguien lo rechazó.
CREATE TABLE evento_auditoria (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_rut TEXT NOT NULL REFERENCES empresa(rut),
  ocurrido_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,
  accion      TEXT NOT NULL,
  borrador_id UUID,
  asiento_numero BIGINT,
  detalle     JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT evento_apunta_a_algo
    CHECK (borrador_id IS NOT NULL OR asiento_numero IS NOT NULL)
);

CREATE INDEX evento_auditoria_por_empresa ON evento_auditoria (empresa_rut, ocurrido_en);

COMMIT;
