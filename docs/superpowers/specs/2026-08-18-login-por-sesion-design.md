# Login por sesión en el MCP del SII — Diseño

## Contexto

Hoy `server.ts` crea al arrancar un único `Browser` y un único
`SessionManager`, construido con `SiiConfig` fijo leído de variables de
entorno (`SII_RUT`, `SII_CLAVE`/`SII_CERT_*`). Todas las tools (`sii_mipyme_*`,
`sii_dte_*`, `sii_bhe_*`, `sii_rcv_*`, `sii_renta_*`, `sii_persona_*`)
comparten ese scraper único.

Esto sirve para un proceso de un solo RUT, pero no para el caso de uso real:
un consultor (o Claude Code en su nombre) atendiendo clientes con RUT y clave
tributaria distintos, sin reiniciar el proceso MCP entre uno y otro.

Ya existe infraestructura multi-tenant escrita y testeada, pero desconectada
de `server.ts`:

- `src/credenciales.ts` — interfaz `ProveedorCredenciales { para(rut):
  Promise<SiiConfig> }` + implementación `CredencialesEnMemoria` (lee de un
  mapa indexado por RUT, pensada para env vars, no para credenciales que
  llegan en runtime).
- `src/registroSesiones.ts` — `RegistroSesiones<T>`: mapa de instancia por
  clave (RUT) + `ColaPorClave` para serializar operaciones del mismo RUT
  (evita el error de sesiones simultáneas del SII).
- `src/registroSesionesSii.ts` — `crearRegistroSesionesSii(proveedor,
  browser)`: junta las dos piezas anteriores para producir un
  `SessionManager` por RUT bajo demanda.

Este spec cablea esa infraestructura y agrega la tool que la alimenta con
credenciales que llegan en tiempo de ejecución, no de env.

**Fuera de alcance** (se abordan en specs posteriores): tool de estado
tributario (régimen/actividad económica), errores tipados por causa más allá
de los definidos acá, y el token de acceso personal del lado de Tributy.

## Decisiones de diseño

- **Identidad de sesión = RUT de la persona que tiene clave tributaria en el
  SII**, no la empresa consultada. `empresa_rut` (donde ya existe en tools
  como `sii_mipyme_*`) sigue siendo un parámetro aparte: selecciona qué
  empresa operar dentro de la sesión ya abierta de esa persona. No se
  introduce ningún `sessionId` opaco — el RUT ya es la clave natural que usa
  `RegistroSesiones`.
- **Sin auto-login implícito.** Si una tool se llama sin sesión abierta para
  ese RUT, falla con un error explícito (`SESION_NO_INICIADA`) en vez de
  loguear silenciosamente. El llamador (Claude Code u otro agente) debe
  invocar `sii_iniciar_sesion` primero y luego reintentar. Esto mantiene el
  paso de login visible y auditable para quien opera el agente.
- **Un `ProveedorCredenciales` nuevo, en memoria, alimentado por la tool** —
  no `CredencialesEnMemoria` existente (esa lee de un mapa fijo pensado para
  env vars al boot). El nuevo proveedor expone un método de escritura además
  de `para(rut)`, y vive sólo mientras dura el proceso — nunca se persiste a
  disco.
- **Reautenticar es login idempotente, no error.** `SessionManager.
  authenticate()` ya es idempotente dentro de la ventana de 2h (`LOCEXP_TTL_MS
  = 7_200_000`), así que llamar `sii_iniciar_sesion` para un RUT con sesión
  viva simplemente la confirma sin abrir una sesión nueva ni pisar cookies.
- **Expiración a mitad de trabajo es un error distinto de no haber logueado
  nunca** (`SESION_EXPIRADA` vs `SESION_NO_INICIADA`), para que el llamador
  sepa que corresponde re-loguear y reintentar, no que faltó un paso.
- **`sii_cerrar_sesion` gana el parámetro `rut`** para cerrar sólo la sesión
  de esa persona, sin afectar sesiones concurrentes de otros RUT que
  `RegistroSesiones` mantiene vivas en paralelo. Además de cerrar el
  `SessionManager`, **borra la clave de ese RUT de `ProveedorCredencialesRuntime`**
  — cerrar sesión no debe dejar la clave en texto plano dando vueltas en
  memoria del proceso indefinidamente. Si el consultor necesita volver a
  operar ese RUT, vuelve a pasar por `sii_iniciar_sesion` con la clave.
- **RUT como clave de mapa se normaliza siempre**, reusando `normalizar()` de
  `src/credenciales.ts:17-18` (`rut.replace(/[^0-9kK]/g, '').toUpperCase()`).
  `ProveedorCredencialesRuntime.guardar`/`.para`, `sii_cerrar_sesion` y el
  borde de entrada de cada tool existente normalizan el `rut` recibido antes
  de usarlo como clave — así `"11.111.111-1"` y `"11111111-1"` resuelven a la
  misma sesión.

## Contrato de las tools

### `sii_iniciar_sesion` (nueva)

**Input:**
```
rut: string    // RUT de la persona, formato normalizado (con o sin puntos/guión)
clave: string  // clave tributaria del SII
```

**Output éxito:**
```
{ ok: true, rut: string }
```

**Output error:**
```
{ ok: false, error: 'CREDENCIALES_INVALIDAS' | 'ERROR' }
```
`CREDENCIALES_INVALIDAS`: el SII rechazó el login (clave incorrecta, RUT no
existe). `ERROR`: fallo de infraestructura (timeout del browser, crash,
etc). La clave nunca se loguea ni se refleja en ningún output.

### `sii_cerrar_sesion` (modificada)

**Input:**
```
rut: string
```

Cierra únicamente la sesión de ese RUT. No afecta otras sesiones activas del
mismo proceso.

### Tools existentes (`sii_mipyme_*`, `sii_dte_*`, `sii_bhe_*`, `sii_rcv_*`, `sii_renta_*`, `sii_persona_*`)

Todas ganan un parámetro requerido nuevo:
```
rut: string  // identidad de sesión — debe tener sesión abierta vía sii_iniciar_sesion
```

Se agrega **antes** de cualquier `empresa_rut` ya existente en esas tools —
`empresa_rut` sigue significando lo mismo que hoy (qué empresa operar), `rut`
es nuevo y es quién la opera.

**Nuevos códigos de error, comunes a todas:**
```
SESION_NO_INICIADA  // no hay SessionManager para ese rut — llamar sii_iniciar_sesion primero
SESION_EXPIRADA     // había sesión pero venció (TTL 2h) — re-loguear y reintentar
```

## Arquitectura

`server.ts` (`createServer()`) deja de instanciar un `SessionManager` fijo
desde `getConfig()`. En su lugar:

1. Instancia un `Browser` único (como hoy).
2. Instancia un nuevo `ProveedorCredencialesRuntime` (nuevo archivo,
   `src/credencialesRuntime.ts`) — mapa en memoria RUT → `SiiConfig`, con
   métodos `guardar(rut, clave)`, `borrar(rut)` además de `para(rut)`.
   `para(rut)` lanza si no hay credenciales guardadas para ese RUT (contrato
   que ya espera `crearRegistroSesionesSii`). Los tres métodos normalizan el
   `rut` recibido con `normalizar()` de `src/credenciales.ts` antes de
   indexar/leer.
3. Instancia `crearRegistroSesionesSii(proveedorRuntime, browser)` una sola
   vez → produce el `RegistroSesiones<SessionManager>` compartido.
4. `registerSesionTools` (donde vive hoy `sii_cerrar_sesion`) gana
   `sii_iniciar_sesion`, con acceso al `proveedorRuntime` (para `guardar`) y
   al registro (para forzar la autenticación tras guardar, devolviendo
   `CREDENCIALES_INVALIDAS` si `authenticate()` falla). `sii_cerrar_sesion`
   gana acceso al `proveedorRuntime` para llamar `borrar(rut)` además de
   cerrar el `SessionManager` correspondiente.
5. Cada `registerXTools(server, ...)` deja de recibir un scraper construido
   sobre un único `SessionManager` fijo. En su lugar recibe el
   `RegistroSesiones<SessionManager>` y, en el handler de cada tool, resuelve
   el `SessionManager` del `rut` recibido vía `registro.ejecutar(rut, fn)` —
   que ya sirve para serializar por RUT (evita sesiones simultáneas del
   mismo RUT) y de paso da el punto natural para atrapar "no existe entrada
   para este RUT" → `SESION_NO_INICIADA`, y "cookie vencida" →
   `SESION_EXPIRADA`.

Ningún scraper deja de compartir el único `Browser` del proceso — sólo el
`SessionManager` pasa de ser uno fijo a resolverse por RUT en cada llamada.

## Testing

- `src/credencialesRuntime.ts`: tests unitarios de `guardar`/`para`/`borrar`
  (guarda y recupera, `para` de un RUT no guardado lanza, `borrar` seguido de
  `para` también lanza, y dos formatos del mismo RUT — con y sin
  puntos/guión — resuelven a la misma entrada).
- `sii_iniciar_sesion`: éxito real requiere credenciales de prueba —
  mockear `SessionManager.authenticate()` para simular éxito/`CREDENCIALES_
  INVALIDAS`/`ERROR` sin pegarle al SII real.
- Reautenticación idempotente: llamar `sii_iniciar_sesion` dos veces para el
  mismo RUT no debe crear una segunda entrada en el registro (test ya
  existente de `registroSesionesSii.test.ts` cubre la forma general;
  agregar caso específico para reautenticación vía la tool).
- Aislamiento entre RUTs: dos RUTs con `sii_iniciar_sesion` distinto deben
  tener `SessionManager` (y cookie jar) independientes — extender el patrón
  ya usado en `registroSesionesSii.test.ts`.
- Tools existentes: agregar caso `SESION_NO_INICIADA` (RUT sin sesión previa)
  y `SESION_EXPIRADA` (mock de sesión vencida) a al menos una tool
  representativa por dominio (`sii_mipyme_list_empresas` alcanza como
  muestra — no hace falta repetir en las 20+ tools, el wiring es el mismo
  `registro.ejecutar` en todas).
- `sii_cerrar_sesion`: verificar que tras cerrar, `ProveedorCredencialesRuntime.
  para(rut)` lanza (la clave ya no está) y una tool llamada después con ese
  RUT da `SESION_NO_INICIADA`, no reautentica sola.
