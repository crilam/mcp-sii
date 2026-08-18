# Endpoint de validación de clave tributaria — Diseño

## Contexto

Tributy (`src/nodos/claveTributaria.ts`) guarda la clave tributaria del SII
por nodo, cifrada, sin verificar nunca que sea correcta contra el SII real —
sólo valida forma (no vacía, ≤256 caracteres). Un consultor puede tipear mal
la clave y no se entera hasta que alguien intente usarla.

Este spec agrega un servicio HTTP nuevo en el repo `mcp-sii` que Tributy
puede llamar para verificar una clave contra el SII real antes de guardarla.
El wiring del lado de Tributy (llamar a este endpoint desde
`guardarClaveTributaria`) queda para un spec/trabajo posterior — este
documento sólo cubre el servicio y el endpoint.

## Decisiones de diseño

- **Proceso nuevo y separado del servidor MCP stdio.** El MCP (para Claude
  Desktop/Code) sigue corriendo local, sin cambios. Este servicio HTTP es un
  proceso aparte, pensado para correr 24/7, que reusa las mismas clases
  (`SessionManager`, `RegistroSesiones`, `crearRegistroSesionesSii`,
  `ProveedorCredencialesRuntime`) sin acoplar su ciclo de vida al del MCP
  local.
- **Hosting: AWS, proceso único de larga duración (EC2 o Fargate — no
  Lambda/serverless).** El `SessionManager` mantiene estado en memoria
  (cookie jar por RUT, vigente 2h) y el SII bloquea sesiones simultáneas del
  mismo RUT; una plataforma serverless puede levantar varias instancias en
  paralelo sin avisar, rompiendo esa invariante. Vercel queda descartado por
  el mismo motivo — sus funciones son efímeras y no garantizan una única
  instancia viva.
- **Aislamiento real entre RUTs vía `agent-browser --session <rut>`.** El
  `Browser` actual de mcp-sii (`src/browser.ts`) no pasa ningún `--session` a
  `agent-browser`, así que todas las operaciones comparten un único contexto
  de navegador global. `agent-browser` sí soporta sesiones aisladas
  (`--session <name>`, cada una con sus propias cookies/tabs/refs — ver
  `agent-browser skills get core`). Este servicio nuevo pasa
  `--session <rutNormalizado>` en cada comando, así que dos validaciones
  concurrentes de RUTs distintos no comparten pestaña ni estado del DOM. (El
  `Browser` del MCP stdio local queda con su comportamiento actual — separado
  a propósito de este spec, ver "Fuera de alcance".)
- **Validación de una sola pasada: sin sesión persistente.** A diferencia de
  `sii_iniciar_sesion` (que deja la sesión viva para operar después), este
  endpoint autentica, confirma el resultado, y **cierra la sesión y descarta
  la credencial** antes de responder. No hay motivo para mantenerla: el único
  propósito es "¿esta clave es correcta?", no dejar nada operable.
- **Auth simple entre Tributy y el servicio: API key compartida fija**, vía
  variable de entorno en ambos lados (`Authorization: Bearer <API_KEY>`). Sin
  rotación automática en esta primera versión — se agrega si hace falta más
  adelante.
- **Sin rate limiting explícito.** El propio SII ya limita sesiones
  simultáneas por RUT, y el endpoint abre y cierra la sesión en el acto. Si
  aparece abuso real (prueba de claves al voleo), se agrega después — no se
  diseña de antemano sin necesidad concreta.
- **La clave nunca se loguea**, ni en los logs de la aplicación ni en los de
  `agent-browser`/curl si algo falla a mitad de camino. Se loguea el `rut`
  para diagnóstico, nunca la `clave`.

**Fuera de alcance** (quedan para specs posteriores): el wiring del lado de
Tributy que llama a este endpoint desde `guardarClaveTributaria`; migrar el
`Browser` del servidor MCP stdio local a usar `--session` también (hoy sigue
compartiendo un único contexto global, sin cambios en este spec); rotación de
la API key; rate limiting.

## Contrato del endpoint

### `POST /validar-clave`

**Headers:**
```
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

**Body:**
```json
{ "rut": "string", "clave": "string" }
```

**Respuesta éxito (200):**
```json
{ "ok": true }
```

**Respuesta error (200 — el fallo de negocio no es un error HTTP):**
```json
{ "ok": false, "error": "CREDENCIALES_INVALIDAS" }
```
```json
{ "ok": false, "error": "ERROR" }
```

- `CREDENCIALES_INVALIDAS`: el SII rechazó el login (clave incorrecta, RUT no
  existe) — mismo criterio que ya usa `sii_iniciar_sesion` en
  `src/tools/bienesRaices.ts` (detecta el mensaje "El SII rechazó la
  autenticación" que lanza `SessionManager.assertAutenticacionExitosa`/el
  flujo de clave).
- `ERROR`: fallo de infraestructura (timeout, browser caído, red).

**Errores HTTP (fuera del contrato `{ok}`):**
- `401 Unauthorized`: falta el header `Authorization` o la API key no
  coincide.
- `400 Bad Request`: body inválido (falta `rut` o `clave`, o no son string).

**Timeout:** 30 segundos totales por request. Si se cumple, responde
`{ ok: false, error: 'ERROR' }` y cierra igual la sesión que haya quedado a
medio abrir (mismo camino que un fallo cualquiera — ver Arquitectura).

## Arquitectura

Archivo nuevo `src/httpServer.ts` (proceso independiente de `src/server.ts`,
que sigue siendo el entrypoint del MCP stdio). Al arrancar:

1. Instancia un `Browser` propio de este proceso (no compartido con ningún
   MCP local — cada proceso, su propio `agent-browser` de fondo).
2. Instancia `ProveedorCredencialesRuntime` (ya existe, de
   `src/credencialesRuntime.ts`) y `crearRegistroSesionesSii` (ya existe) —
   mismo patrón que `server.ts`.
3. Levanta un servidor HTTP mínimo (sin framework nuevo si el repo no tiene
   uno — usar `http` nativo de Node o, si ya hay una dependencia liviana
   preferida por el equipo, esa) escuchando `POST /validar-clave`.
4. El handler de `/validar-clave`:
   - Valida el header `Authorization` contra `API_KEY` (env var nueva,
     `VALIDACION_API_KEY` o similar — nombre exacto a definir en el plan).
   - Valida el body (`rut`, `clave` presentes y string).
   - `credenciales.guardar(rut, clave)`.
   - `await registro.ejecutar(rut, sesion => sesion.authenticateOnly())`
     dentro de un timeout de 30s (`Promise.race` o equivalente).
   - Pase lo que pase (éxito, `CREDENCIALES_INVALIDAS`, `ERROR`, timeout):
     `await registro.ejecutar(rut, sesion => sesion.logout())` y
     `credenciales.borrar(rut)` antes de responder — la sesión no debe
     sobrevivir a la respuesta bajo ningún camino.
   - Responde `{ ok: true }` o `{ ok: false, error }` según corresponda.

El `Browser` de este proceso debe pasar `--session <rutNormalizado>` a cada
comando `agent-browser` que ejecute (requiere tocar `src/browser.ts` para que
acepte un identificador de sesión — ver Testing para el detalle de qué
verificar). Esto es lo único que cambia en `Browser`/`SessionManager` para
este spec: el resto de sus métodos siguen iguales.

Despliegue: build de TypeScript (`npm run build`, ya existe) + `node
dist/src/httpServer.js` corriendo como servicio persistente (systemd,
pm2, o el mecanismo que se elija en el plan) en una instancia EC2 o tarea
Fargate de larga duración. La instancia necesita `agent-browser` instalado
(`npm install -g agent-browser && agent-browser install`, igual que en
desarrollo local) y salida de red hacia el SII.

## Testing

- Handler de `/validar-clave`: mockear `RegistroSesiones`/`SessionManager`
  (patrón ya usado en `tests/tools/sesion.test.ts`) para probar: éxito,
  `CREDENCIALES_INVALIDAS`, `ERROR` de infraestructura, y que en los tres
  casos se llama `logout()` y `credenciales.borrar(rut)` antes de responder.
- Auth: request sin `Authorization` → 401; con API key incorrecta → 401.
- Body inválido (falta `rut` o `clave`) → 400.
- Timeout: simular una promesa que nunca resuelve y confirmar que a los 30s
  responde `{ ok: false, error: 'ERROR' }` (usar timers falsos de Jest, no
  esperar 30s reales).
- `Browser` con `--session`: test unitario confirmando que cada método
  (`open`, `snapshot`, `click`, etc.) incluye `--session <id>` en el comando
  construido, dado un `Browser` instanciado con un identificador de sesión.
