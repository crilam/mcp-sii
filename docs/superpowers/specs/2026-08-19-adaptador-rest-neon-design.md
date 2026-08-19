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

## Alcance: las 16 operaciones + validar-clave

Cada tool MCP existente se mapea 1:1 a una ruta REST, con el mismo cuerpo de
parámetros que ya define su schema zod hoy (en `src/tools/*.ts`), sumando
siempre `rut` + `clave` en vez de depender de una sesión ya iniciada:

| Tool MCP | Ruta REST |
|---|---|
| `sii_iniciar_sesion` / `sii_cerrar_sesion` | no se exponen — el REST no deja sesión viva entre requests (ver "Sin Secrets Manager") |
| `sii_bhe_resumen` | `POST /bhe/resumen` |
| `sii_bhe_list_emitidas` | `POST /bhe/list-emitidas` |
| `sii_bhe_list_recibidas` | `POST /bhe/list-recibidas` |
| `sii_rcv_resumen` | `POST /rcv/resumen` |
| `sii_rcv_detalle` | `POST /rcv/detalle` |
| `sii_renta_estado_declaracion` | `POST /renta/estado-declaracion` |
| `sii_renta_get_f22` | `POST /renta/f22` |
| `sii_dte_list_documentos_emitidos` | `POST /dte/list-documentos-emitidos` |
| `sii_dte_list_documentos_recibidos` | `POST /dte/list-documentos-recibidos` |
| `sii_dte_get_documento_emitido` | `POST /dte/get-documento-emitido` |
| `sii_dte_get_documento_recibido` | `POST /dte/get-documento-recibido` |
| `sii_mipyme_list_empresas` | `POST /mipyme/list-empresas` |
| `sii_mipyme_list_dte_emitidos` | `POST /mipyme/list-dte-emitidos` |
| `sii_mipyme_emitir_dte` | `POST /mipyme/emitir-dte` (ver limitación abajo) |
| `sii_persona_list_bienes_raices` | `POST /persona/bienes-raices` |
| — (nuevo, PR #32) | `POST /sesion/validar-clave` |

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
        │  POST /rcv/resumen, /sesion/validar-clave, ... (17 rutas)
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
        │        mipyme), funciones puras extraídas de src/tools/*.ts
        ▼
RegistroSesiones + ColaPorClave + SessionManager (sin cambios)
```

Hoy la lógica de cada operación vive mezclada adentro de `registerXTools()` en
`src/tools/*.ts`, atada al formato `{content:[{type:'text',...}]}` que exige el
SDK de MCP. Se extrae a `src/core/<dominio>.ts`: funciones `async` que reciben
`(registro, rut, ...params)` y devuelven el dato crudo o lanzan — sin saber
nada de HTTP ni de MCP. `src/tools/<dominio>.ts` pasa a ser un adaptador fino
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
