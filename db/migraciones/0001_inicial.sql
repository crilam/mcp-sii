CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre           text NOT NULL UNIQUE,
  limite_por_minuto int NOT NULL DEFAULT 60,
  creado_en        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  key_hash     text NOT NULL UNIQUE,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  revocada_en  timestamptz
);

CREATE TABLE rate_limit_contador (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  ventana_inicio timestamptz NOT NULL,
  contador       int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, ventana_inicio)
);

CREATE TABLE auth_fallida_contador (
  ip             inet NOT NULL,
  ventana_inicio timestamptz NOT NULL,
  contador       int NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, ventana_inicio)
);

CREATE TABLE auditoria (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(id),
  ip          inet NOT NULL,
  rut         text,
  ruta        text NOT NULL,
  status      int NOT NULL,
  error       text,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
