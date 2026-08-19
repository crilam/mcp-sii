# Adaptador REST + base operacional (Neon) — Diseño

## Contexto

`docs/superpowers/specs/2026-08-12-arquitectura-servicio-sii.md` define a mcp-sii
como servicio externo con dos adaptadores sobre un mismo core: MCP (ya existe) y
REST (nuevo). La cola por RUT ya está cableada (PR #31); este documento cubre el
paso siguiente: el adaptador REST y lo que hace falta para operarlo multi-tenant
(RDTE, AgenticERP, gateway de boletas de Parkingapp, y eventualmente terceros).

El endpoint `sii_validar_clave` (PR #32, `src/httpServer.ts`) ya es un proceso
HTTP separado, con su propia auth de API key fija por env var. Este diseño lo
absorbe como una ruta más del adaptador REST nuevo, con el mismo esquema de auth
por tenant.

## Decisiones de diseño

- **Sin Secrets Manager en v1.** Los consumidores previstos (RDTE, AgenticERP)
  ya van a custodiar la clave tributaria de sus propios usuarios y reenviarla en
  cada request — igual que ya hace `sii_iniciar_sesion`/`validar-clave` hoy.
  Guardar una segunda copia de la clave en Secrets Manager sería duplicar
  custodia sin que nadie lo haya pedido. Cada ruta REST recibe `rut` + `clave`
  en el body; el servicio nunca persiste la clave, solo la usa para esa
  operación y la descarta (mismo patrón que `validarClave` en `httpServer.ts`).
  Se reconsidera si aparece un consumidor concreto que no quiera manejar la
  clave del lado suyo.
- **Base operacional en Neon (Postgres serverless), separada de las claves SII.**
  No es un cambio a la decisión "sin base de datos propia" de la spec del
  2026-08-12 sobre *datos del SII* (siguen sin persistirse: las sesiones son
  efímeras, los datos viven en el SII). Es una base nueva y chica para datos que
  sí son del propio servicio: tenants, API keys, contadores de rate limit y
  auditoría de requests. Elegida sobre RDS/Aurora porque no hay infra que
  administrar (sin VPC, subnet groups, parches) — coherente con el criterio ya
  aplicado de no operar infra que no hace falta operar. Elegida sobre Supabase
  porque no se necesita nada de lo que Supabase agrega (auth propio, storage,
  realtime): ya hay un modelo de auth por API key definido acá.
- **Una ruta HTTP por operación**, no un endpoint genérico `/ejecutar`. Cada
  ruta valida su propio body con zod (mismo patrón que ya usan las tools MCP) y
  es autodescriptiva — análogo a cómo ya están separadas las tools de
  `McpServer` hoy.
- **Rate limit: N requests/minuto por tenant**, con contador en Neon (no en
  memoria del proceso, para que sobreviva un restart y esté listo si el
  servicio corre en más de una instancia a futuro). Ventana fija de un minuto,
  no deslizante — más simple, alcanza para el caso de uso (evitar que un
  consumidor sature el servicio o dispare el límite de sesiones simultáneas del
  SII).
- **Alta de tenants/API keys: script CLI interno**, no un endpoint HTTP de
  administración. Coherente con "no construir web/API de administración propia"
  ya decidido para las credenciales SII — evita crear una segunda clase de
  credencial (una master key) sólo para dar de alta tenants, que hoy son pocos
  y cambian poco.
- **`validar-clave` se absorbe en este adaptador** como `POST
  /sesion/validar-clave`, autenticada con el mismo esquema de API key por
  tenant en Neon en vez de la API key fija por env var que tiene hoy. Un solo
  proceso HTTP, un solo modelo de auth para todo REST.
- **Errores de transporte vs. errores de negocio, mismo criterio que
  `validar-clave`:** auth/rate-limit/body inválido usan status HTTP no-200;
  clave rechazada por el SII o falla de infraestructura del SII responden
  `200 {ok:false, error}` — porque el caller ya está autenticado y autorizado,
  solo está preguntando algo que puede fallar del lado del SII.
- **Neon caído — fail-closed en auth, fail-open en rate-limit.** Si no se
  puede consultar `api_keys`, el request se rechaza (`401` o `503`, a definir
  en el plan): nunca dejar pasar un request sin poder verificar la key sería
  peor que una caída parcial del servicio. Si la key ya se validó pero
  `rate_limit_contador` no responde, el request sigue adelante sin contar
  contra el límite — preferible degradar el rate-limit a tirar el servicio
  entero por un problema de un contador. La escritura en `auditoria` nunca
  bloquea ni falla el request (ver sección "Auditoría").
- **Formato de API key:** `sk_<nombre-tenant>_<32 bytes aleatorios en
  base64url>`, generados con `crypto.randomBytes(32)` en el script CLI de alta
  (nunca `Math.random`). Se muestra una única vez al crear el tenant/key —
  sólo se guarda su `sha256` en `api_keys.key_hash`, igual que ya se hace con
  la comparación de la API key de `validar-clave` hoy.
- **Migraciones del esquema de Neon: SQL plano versionado, sin librería de
  migraciones.** Coherente con "sin ORM": archivos numerados en
  `db/migraciones/0001_inicial.sql`, `0002_...sql`, aplicados a mano (o con un
  script mínimo que corre los que falten, a definir en el plan) contra la
  base de Neon. No se introduce una herramienta como Prisma Migrate o
  Flyway para 4 tablas.
- **Connection pooling:** el proceso usa el *pooled connection string* de
  Neon (vía PgBouncer, vive del lado de Neon) con un `pg.Pool` chico del lado
  del cliente (`max` bajo, ej. 5-10) — Neon limita las conexiones directas y
  un pool grande del lado Node las agota rápido. Se define el valor exacto de
  `max` en el plan, según el tier de Neon elegido.
- **TLS: lo termina el load balancer, no el proceso Node.** Igual que el
  resto del despliegue en AWS (EC2/Fargate detrás de ALB, ya decidido para
  `validar-clave`): el ALB atiende HTTPS hacia afuera y habla HTTP plano con
  el proceso puertas adentro de la VPC. El proceso Node nunca maneja
  certificados TLS directamente.
- **Sin CORS.** El adaptador es server-to-server (RDTE, AgenticERP,
  Parkingapp, terceros vía backend) — ningún consumidor llama desde un
  browser. No se agrega manejo de CORS; si algún día hiciera falta, es una
  señal de que cambió el modelo de consumo y hay que revisar el diseño, no
  sólo agregar un header.
- **Todas las rutas bajo prefijo `/v1`.** `POST /v1/rcv/resumen`, etc. Sin
  versión en la URL, el primer cambio incompatible en el contrato de una ruta
  rompe a todos los consumidores sin aviso — barato de poner ahora, caro de
  meter después de que terceros ya integraron. `/v2` conviviría con `/v1` el
  tiempo que haga falta migrar consumidores, no un reemplazo instantáneo.
- **`GET /health` sin autenticar**, responde `200` si el proceso puede
  responder y `503` si no puede conectar a Neon (mismo criterio fail-closed
  que auth). Es el target del health check del load balancer (ALB) — sin él,
  el ALB no tiene forma de saber si una instancia está viva.
- **El header `Authorization` nunca llega a un log de aplicación.** Mismo
  criterio ya vigente para la clave tributaria ("la clave nunca se loguea"),
  extendido a la API key del tenant: cualquier logger de request/error debe
  omitir explícitamente el header `Authorization` (no loguear `req.headers`
  completo tal cual, ni volcar el objeto de error si pudiera arrastrar
  headers). Un error no controlado que serialice el request entero filtraría
  la key.
- **Idempotencia: fuera de alcance para v1, con una nota para cuando se
  habilite la firma real.** Ninguna operación de v1 escribe nada irreversible
  en el SII (`/mipyme/emitir-dte` está limitado a previsualización, ver
  limitación abajo), así que un reintento de un consumidor ante un timeout de
  red no tiene costo real hoy — como mucho, dos previsualizaciones o dos filas
  de auditoría. **Antes de habilitar la firma real** en `/mipyme/emitir-dte`
  hay que resolver esto: un reintento de un POST que ya se procesó del lado
  del SII no debe volver a emitir el documento. La solución típica (una
  `Idempotency-Key` por request, deduplicada contra `auditoria` o una tabla
  nueva) se diseña en ese momento, no ahora — dejarlo anotado para que no se
  pierda de vista.

## Alcance: las 16 operaciones + validar-clave

Cada tool MCP existente se mapea 1:1 a una ruta REST bajo `/v1`, con el mismo
cuerpo de parámetros que ya define su schema zod hoy (en `src/tools/*.ts`),
sumando siempre `rut` + `clave` en vez de depender de una sesión ya iniciada.
**El schema zod de cada operación se define una sola vez** — junto al core en
`src/core/<dominio>.ts` o en un archivo de schemas por dominio — y lo importan
tanto `tools/<dominio>.ts` (para el `server.tool(...)`) como
`rest/rutas/<dominio>.ts` (para validar el body del request). Definirlo dos
veces sería la misma duplicación que ya se corrigió con `crearConScraper` y
`clasificarErrorCredenciales` en el PR #31: diverge la primera vez que alguien
agregue un campo opcional en un lado y se olvide del otro.

| Tool MCP | Ruta REST |
|---|---|
| `sii_iniciar_sesion` / `sii_cerrar_sesion` | no se exponen — el REST no deja sesión viva entre requests (ver "Sin Secrets Manager") |
| `sii_bhe_resumen` | `POST /v1/bhe/resumen` |
| `sii_bhe_list_emitidas` | `POST /v1/bhe/list-emitidas` |
| `sii_bhe_list_recibidas` | `POST /v1/bhe/list-recibidas` |
| `sii_rcv_resumen` | `POST /v1/rcv/resumen` |
| `sii_rcv_detalle` | `POST /v1/rcv/detalle` |
| `sii_renta_estado_declaracion` | `POST /v1/renta/estado-declaracion` |
| `sii_renta_get_f22` | `POST /v1/renta/f22` |
| `sii_dte_list_documentos_emitidos` | `POST /v1/dte/list-documentos-emitidos` |
| `sii_dte_list_documentos_recibidos` | `POST /v1/dte/list-documentos-recibidos` |
| `sii_dte_get_documento_emitido` | `POST /v1/dte/get-documento-emitido` |
| `sii_dte_get_documento_recibido` | `POST /v1/dte/get-documento-recibido` |
| `sii_mipyme_list_empresas` | `POST /v1/mipyme/list-empresas` |
| `sii_mipyme_list_dte_emitidos` | `POST /v1/mipyme/list-dte-emitidos` |
| `sii_mipyme_emitir_dte` | `POST /v1/mipyme/emitir-dte` (ver limitación abajo) |
| `sii_persona_list_bienes_raices` | `POST /v1/persona/bienes-raices` |
| — (nuevo, PR #32) | `POST /v1/sesion/validar-clave` |
| — (nuevo) | `GET /health` (sin `/v1`, sin auth — ver "Decisiones de diseño") |

**Limitación conocida — resolución de `empresa_rut`:** `sii_mipyme_list_dte_emitidos`
y `sii_mipyme_emitir_dte` hoy resuelven la empresa en tres escalones: parámetro
explícito → `SII_EMPRESA_RUT` (env var del *proceso*) → autoresolución si la
persona opera una única empresa en el portal. El segundo escalón no tiene
sentido en REST multi-tenant — es una env var de un solo proceso, no hay
"la empresa de este tenant" configurable ahí, y dejarlo tal cual arriesga que
un request sin `empresa_rut` explícito use silenciosamente la empresa que haya
quedado configurada para OTRO contribuyente. Las rutas REST de estas dos
operaciones **eliminan el escalón de `SII_EMPRESA_RUT`**: sólo param explícito
o autoresolución de empresa única; si ninguna aplica, responden `400` pidiendo
`empresa_rut` explícito (en vez de fallar tarde contra el SII).

**Limitación conocida, no resuelta en este spec:** `sii_mipyme_emitir_dte` con
`confirmar=true` firma con certificado digital, cuya clave hoy sólo se
configura vía `SII_CERT_CLAVE_SII`/`SII_CERT_PASSWORD` — variables de entorno
del *proceso*, una por contribuyente. Eso es incompatible con multi-tenant vía
REST tal cual está: no hay forma de que dos RUT con certificados distintos
firmen documentos en el mismo proceso sin credencial por request. La ruta REST
`/mipyme/emitir-dte` se expone en modo previsualización (`confirmar` omitido u
`false`) desde el día uno; **habilitar la firma real queda bloqueado hasta
resolver el pendiente ya documentado en la memoria del proyecto** ("certificado
digital pendiente" — soportar `certPath`/`certPassword` en el flujo de
credencial por request, igual que hoy se soporta `clave`).

## Arquitectura: core compartido entre MCP y REST

```
RDTE / AgenticERP / Parkingapp / terceros
        │  POST /v1/rcv/resumen, /v1/sesion/validar-clave, ... (17 rutas + /health)
        │  Authorization: Bearer <api-key-del-tenant>
        ▼
src/restServer.ts  (proceso HTTP nuevo — reemplaza a httpServerIndex.ts,
        │           que se retira: validar-clave pasa a vivir acá)
        ├─ autenticarTenant(apiKey)  → hash contra Neon, resuelve tenant
        ├─ chequearRateLimit(tenant) → contador por minuto en Neon
        ├─ valida body (zod, por ruta)
        ├─ llama al core de la operación (mismo core que usan las tools MCP)
        ├─ registra en auditoria (Neon)
        └─ responde JSON
        │
        ▼
src/core/*.ts — un archivo por dominio (bhe, dte, rcv, renta, bienesRaices,
        │        mipyme), funciones de dominio extraídas de src/tools/*.ts
        ▼
RegistroSesiones + ColaPorClave + SessionManager (sin cambios)
```

Hoy la lógica de cada operación vive mezclada adentro de `registerXTools()` en
`src/tools/*.ts`, atada al formato `{content:[{type:'text',...}]}` que exige el
SDK de MCP. Se extrae a `src/core/<dominio>.ts`: funciones de dominio `async`
(no puras — hacen I/O real contra el SII) que reciben `(registro, rut,
...params)` y devuelven el dato crudo o lanzan, sin saber nada de HTTP ni de
MCP. `src/tools/<dominio>.ts` pasa a ser un adaptador fino
que llama al core y envuelve en `{content:...}`; `src/rest/rutas/<dominio>.ts`
es el otro adaptador fino, que llama al mismo core y arma la respuesta HTTP.

Ejemplo (`rcv.resumen`):

```typescript
// src/core/rcv.ts
export async function resumen(
  registro: RegistroSesiones<SessionManager>,
  rut: string,
  anio: number,
  mes: number
): Promise<ResumenRcv> {
  return conErroresDeSesion(() =>
    registro.ejecutar(rut, async sesion => {
      const scraper = new RcvScraper(new SiiHttpClient(sesion), sesion);
      return scraper.resumen(anio, mes);
    })
  );
}
```

`crearConScraper` (extraído en el PR #31) se separa en dos capas: la ejecución
contra el scraper pasa al core; el envoltorio `{content:...}` queda sólo en
`tools/*.ts`. La traducción de `SesionNoIniciada` difiere por adaptador: la
tool MCP sigue devolviendo `{ok:false,error:'SESION_NO_INICIADA'}` (una sesión
ya iniciada por `sii_iniciar_sesion` puede expirar entre llamadas); la ruta
REST nunca debería ver ese caso — cada request pasa `clave` y arma la sesión de
cero — así que si ocurriera, se trata como `ERROR` de infraestructura, no como
un caso de negocio esperado.

## Esquema de Neon

```sql
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      text NOT NULL UNIQUE,       -- 'rdte', 'agenticerp', 'parkingapp'
  creado_en   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  key_hash     text NOT NULL UNIQUE,      -- sha256 de la key real; la key real nunca se guarda
  creado_en    timestamptz NOT NULL DEFAULT now(),
  revocada_en  timestamptz                -- NULL = activa
);

CREATE TABLE rate_limit_contador (
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  ventana_inicio timestamptz NOT NULL,    -- truncado al minuto
  contador       int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, ventana_inicio)
);

CREATE TABLE auditoria (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  rut         text NOT NULL,
  ruta        text NOT NULL,
  status      int NOT NULL,
  error       text,                       -- 'CREDENCIALES_INVALIDAS' | 'ERROR' | null
  creado_en   timestamptz NOT NULL DEFAULT now()
);
```

La `clave` tributaria **nunca** se escribe en ninguna tabla — mismo criterio ya
vigente para `validar-clave` ("la clave nunca se loguea"). Cliente Postgres:
`pg` (node-postgres) directo, sin ORM, mismo criterio de "sin framework que no
haga falta" ya aplicado al elegir `http` nativo sobre un framework HTTP.

**Rate limit — mecánica:** por request, `INSERT INTO rate_limit_contador (...)
VALUES (...) ON CONFLICT (tenant_id, ventana_inicio) DO UPDATE SET contador =
rate_limit_contador.contador + 1 RETURNING contador`. Si el valor devuelto
supera el límite configurado para el tenant → `429`. El límite por tenant es
una columna en `tenants` (a agregar: `limite_por_minuto int NOT NULL DEFAULT
60`), no una constante global — tenants distintos pueden necesitar límites
distintos.

**Pendiente para servicio de larga vida (no bloquea v1):** `rate_limit_contador`
y `auditoria` crecen sin límite ni evicción — mismo tipo de pendiente ya
anotado para los mapas de `RegistroSesiones`/`ColaPorClave` en la spec del
2026-08-12. `rate_limit_contador` sólo necesita las últimas ventanas (un job
periódico que borre filas de más de un día alcanza); `auditoria` es un log de
negocio que probablemente se quiera conservar más tiempo — definir política de
retención cuando el volumen real lo exija, no de antemano.

## Contrato HTTP — tabla de errores

| Situación | Status | Body |
|---|---|---|
| Sin `Authorization` o key inválida/revocada | 401 | `{error:'UNAUTHORIZED'}` |
| Rate limit superado | 429 | `{error:'RATE_LIMITED'}` |
| Body inválido (falta campo, tipo incorrecto) | 400 | `{error:'BAD_REQUEST'}` |
| Body > 4KB | 413 | `{error:'PAYLOAD_TOO_LARGE'}` |
| Ruta desconocida | 404 | — |
| SII rechazó la clave | 200 | `{ok:false,error:'CREDENCIALES_INVALIDAS'}` |
| Fallo de infraestructura (timeout, browser caído, sesión inesperada) | 200 | `{ok:false,error:'ERROR'}` |
| Éxito | 200 | `{ok:true, ...datos}` |

Body de cada request: siempre incluye `rut: string` y `clave: string`, más los
parámetros propios de la operación (idénticos a los que ya define el schema
zod de la tool MCP equivalente en `src/tools/*.ts`).

## Auditoría

Cada request, exitoso o no, deja una fila en `auditoria` con `tenant_id`,
`rut`, `ruta`, `status`, `error` (si lo hay) — nunca `clave`. Se escribe
después de responder al cliente (no debe poder atrasar ni romper la respuesta
si la escritura a Neon falla; un fallo de auditoría se loguea a stderr, no se
propaga como error del request).

## Fuera de alcance de este documento

- Secrets Manager para custodiar la clave tributaria — ver "Decisiones de
  diseño".
- Firma con certificado digital multi-tenant vía REST (`sii_mipyme_emitir_dte`
  con `confirmar=true`) — ver "Limitación conocida" arriba. Depende del
  pendiente de certificado digital ya documentado en la memoria del proyecto.
- Egress IP configurable / IP estable por RUT — según la spec del 2026-08-12,
  es un problema de volumen que no existe todavía.
- Rotación de API keys — se revocan y se crean nuevas a mano con el mismo
  script CLI; no hay rotación automática ni fecha de expiración en v1.
- UI de administración de tenants — el script CLI es la única interfaz de alta
  en v1.

## Testing

- **Core** (`tests/core/*.test.ts`): mismos casos que ya cubren
  `tests/tools/*.test.ts` hoy, movidos/duplicados al core, mockeando
  `RegistroSesiones` igual que ya se hace.
- **Rutas REST** (`tests/rest/*.test.ts`): mismo patrón que
  `tests/httpServer.test.ts` de `validar-clave` — servidor real en puerto
  efímero, cliente `http` nativo — con un tenant + API key de prueba insertados
  antes de cada test contra una base de test (Postgres real, no mockeado: la
  lógica de auth/rate-limit vive en SQL y mockearla no la prueba).
- **Auth**: sin `Authorization` → 401; con key inexistente → 401; con key
  revocada (`revocada_en` no nulo) → 401.
- **Rate limit**: N requests seguidos dentro del límite → todos 200/passthrough
  de negocio; el N+1 dentro de la misma ventana → 429; pasado el minuto, el
  contador vuelve a 0 y el siguiente request no es 429.
- **Auditoría**: cada request de prueba deja exactamente una fila esperada en
  `auditoria`, y esa fila nunca contiene el valor de `clave` usado en el
  request.
- **`/mipyme/emitir-dte`**: test que confirma que `confirmar=true` es
  rechazado o ignorado en v1 (según se decida en el plan) mientras el
  certificado multi-tenant no esté resuelto — no debe ser posible emitir un
  documento real por esta vía todavía.
- **`GET /health`**: responde `200` sin necesitar `Authorization`; con Neon
  inalcanzable (mockeado en el test) responde `503`.
- **Logging**: test que confirma que un request con `Authorization` inválido
  no deja ese header en ningún log/salida capturable (ni en el mensaje de
  error que arma el 401).
