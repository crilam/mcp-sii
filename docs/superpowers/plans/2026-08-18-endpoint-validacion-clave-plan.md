# Endpoint de validación de clave tributaria — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un servicio HTTP nuevo y separado (`POST /validar-clave`) que Tributy puede llamar para verificar una clave tributaria contra el SII real antes de guardarla, sin dejar ninguna sesión abierta ni credencial en memoria al responder.

**Architecture:** Proceso Node independiente del MCP stdio (`src/server.ts`/`src/index.ts` no cambian de comportamiento). Reusa `RegistroSesiones`, `SessionManager`, `ProveedorCredencialesRuntime` ya existentes. La única pieza de bajo nivel que cambia es `Browser`, que ahora acepta un `sessionId` opcional y lo pasa como `--session <id>` a cada comando de `agent-browser`, para aislar el contexto de navegador de cada RUT validado. El handler HTTP arma la sesión, autentica, y en el mismo turno de la cola por RUT hace `logout()` en un `finally` — no como una llamada a `registro.ejecutar` separada — así el cleanup nunca queda encolado detrás de una operación colgada.

**Tech Stack:** TypeScript, Node `http` nativo (sin framework nuevo — el repo no tiene uno), Jest para tests, `crypto.timingSafeEqual` para la comparación de API key.

**Spec:** `docs/superpowers/specs/2026-08-18-endpoint-validacion-clave-design.md`

## Global Constraints

- La clave nunca se loguea (ni en logs de la app ni en los de `agent-browser`/curl). Se loguea el `rut`, nunca la `clave`.
- La sesión no debe sobrevivir a la respuesta bajo ningún camino (éxito, `CREDENCIALES_INVALIDAS`, `ERROR`): `logout()` y `credenciales.borrar(rut)` corren siempre.
- El fallo de negocio (`CREDENCIALES_INVALIDAS`, `ERROR`) responde HTTP 200 con `{ ok: false, error }`. Sólo problemas de transporte (auth, body inválido) usan status HTTP no-200.
- Sin rate limiting, sin rotación de API key en esta versión — fuera de alcance explícito.
- El `Browser` del MCP stdio local (`src/server.ts`) no cambia de comportamiento: sigue sin `--session`.

---

## File Structure

- **Modifica** `src/browser.ts`: constructor acepta `sessionId?: string`; todos los comandos pasan por un único punto (`run`) que antepone `--session <id>` cuando corresponde.
- **Modifica** `src/erroresSesion.ts`: agrega `clasificarErrorCredenciales(e: unknown)`, extraído de la lógica ya duplicada una vez en `src/tools/bienesRaices.ts`.
- **Modifica** `src/tools/bienesRaices.ts`: usa el `clasificarErrorCredenciales` extraído en vez de su copia inline (evita que exista una segunda copia apenas se agregue el consumidor nuevo).
- **Crea** `src/apiKey.ts`: comparación de API key en tiempo constante.
- **Crea** `src/httpServer.ts`: `validarClave()` (lógica pura, sin HTTP) y `crearServidorHttp()` (routing HTTP mínimo con `http` nativo).
- **Crea** `src/httpServerIndex.ts`: entrypoint del proceso — lee env vars, arma las piezas, llama `.listen()`. Mismo rol que `src/index.ts` para el MCP stdio.
- **Modifica** `package.json`: agrega script `start:validar-clave`.
- **Tests:** `tests/browser.test.ts` (agrega casos), `tests/erroresSesion.test.ts` (agrega casos), `tests/apiKey.test.ts` (nuevo), `tests/httpServer.test.ts` (nuevo, cubre `validarClave` y `crearServidorHttp`).

---

### Task 1: `Browser` acepta `sessionId` y lo pasa como `--session <id>`

**Files:**
- Modify: `src/browser.ts`
- Test: `tests/browser.test.ts`

**Interfaces:**
- Consumes: nada nuevo (mismo `execSync` ya usado).
- Produces: `new Browser(sessionId?: string)`. Sin `sessionId`, el comportamiento es idéntico al actual (mismos strings de comando, los tests existentes no cambian). Con `sessionId`, cada comando queda `agent-browser --session <id> <resto>`.

- [ ] **Step 1: Escribir el test que falla**

Agregar al final de `tests/browser.test.ts` (antes del cierre del `describe`):

```typescript
  it('con sessionId, antepone --session a cada comando', () => {
    const browser2 = new Browser('11111111-1');
    mockExec.mockReturnValue(Buffer.from(''));
    browser2.open('https://example.com');
    expect(mockExec).toHaveBeenCalledWith(
      'agent-browser --session 11111111-1 open https://example.com',
      expect.any(Object)
    );
  });

  it('sin sessionId, no antepone --session (comportamiento actual intacto)', () => {
    mockExec.mockReturnValue(Buffer.from(''));
    browser.snapshot();
    expect(mockExec).toHaveBeenCalledWith('agent-browser snapshot', expect.any(Object));
  });
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/browser.test.ts -t "sessionId"`
Expected: FAIL — `Browser` no tiene constructor con parámetro, o el comando no incluye `--session`.

- [ ] **Step 3: Implementar el cambio mínimo**

Reemplazar el contenido de `src/browser.ts` completo por:

```typescript
import { execSync } from 'child_process';

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 30_000 };

export class Browser {
  constructor(private sessionId?: string) {}

  private run(args: string): string {
    const prefijoSesion = this.sessionId ? `--session ${this.sessionId} ` : '';
    return execSync(`agent-browser ${prefijoSesion}${args}`, EXEC_OPTS).toString().trim();
  }

  open(url: string): void {
    this.run(`open ${url}`);
  }

  // Navega a una URL que puede mostrar un JS confirm dialog durante la carga.
  // Captura el error provocado por el dialog (execSync pone el output en err.stderr/stdout,
  // no en err.message) y lo deja pendiente para que el llamador resuelva con dialogAccept().
  openWithPendingDialog(url: string): void {
    try {
      this.run(`open ${url}`);
    } catch (err: unknown) {
      const allText = [
        err instanceof Error ? err.message : String(err),
        (err as any)?.stderr?.toString() ?? '',
        (err as any)?.stdout?.toString() ?? '',
      ].join(' ');
      if (!/timed.?out|ETIMEDOUT|dialog/i.test(allText)) throw err;
    }
  }

  snapshot(): string {
    return this.run('snapshot');
  }

  click(ref: string): void {
    this.run(`click ${ref}`);
  }

  fill(ref: string, text: string): void {
    this.run(`fill ${ref} "${text}"`);
  }

  type(ref: string, text: string): void {
    this.run(`type ${ref} "${text}"`);
  }

  getText(ref: string): string {
    return this.run(`get text ${ref}`);
  }

  select(ref: string, value: string): void {
    this.run(`select ${ref} "${value}"`);
  }

  eval(js: string): string {
    const escaped = js.replace(/"/g, '\\"');
    return this.run(`eval "${escaped}"`);
  }

  press(key: string): void {
    this.run(`press ${key}`);
  }

  dialogAccept(): void {
    this.run('dialog accept');
  }

  dialogDismiss(): void {
    this.run('dialog dismiss');
  }

  waitForAny(texts: string[], maxMs = 10_000): void {
    const step = 2_000;
    let elapsed = 0;
    while (elapsed < maxMs) {
      const s = this.snapshot();
      if (texts.some(t => s.includes(t))) return;
      execSync(`sleep ${step / 1000}`);
      elapsed += step;
    }
  }

  // Espera a que aparezca un texto en el snapshot (polling, max 10s por defecto)
  waitFor(text: string, maxMs = 10_000): void {
    const step = 2_000;
    let elapsed = 0;
    while (elapsed < maxMs) {
      const s = this.snapshot();
      if (s.includes(text)) return;
      execSync(`sleep ${step / 1000}`);
      elapsed += step;
    }
  }

  close(): void {
    this.run('close');
  }
}
```

- [ ] **Step 4: Correr TODOS los tests de `browser.test.ts` y confirmar que pasan**

Run: `npx jest tests/browser.test.ts`
Expected: PASS — todos, incluidos los que ya existían (los comandos generados sin `sessionId` son idénticos a los de antes).

- [ ] **Step 5: Correr la suite completa para descartar roturas en otros archivos que usan `Browser`**

Run: `npm test`
Expected: PASS — `src/server.ts`, `src/tools/bienesRaices.ts` y cualquier otro consumidor siguen instanciando `new Browser()` sin argumentos, comportamiento sin cambios.

- [ ] **Step 6: Commit**

```bash
git add src/browser.ts tests/browser.test.ts
git commit -m "feat: Browser acepta sessionId opcional y lo pasa como --session a agent-browser"
```

---

### Task 2: Extraer `clasificarErrorCredenciales` a `erroresSesion.ts`

**Files:**
- Modify: `src/erroresSesion.ts`
- Modify: `src/tools/bienesRaices.ts`
- Test: `tests/erroresSesion.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `clasificarErrorCredenciales(e: unknown): 'CREDENCIALES_INVALIDAS' | 'ERROR'`. Task 4 (`validarClave`) consume esta función.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/erroresSesion.test.ts`:

```typescript
import { clasificarErrorCredenciales, conErroresDeSesion, SesionNoIniciada } from '../src/erroresSesion';

describe('clasificarErrorCredenciales', () => {
  it('clasifica el rechazo de autenticación del SII como CREDENCIALES_INVALIDAS', () => {
    const error = new Error('El SII rechazó la autenticación: clave incorrecta');
    expect(clasificarErrorCredenciales(error)).toBe('CREDENCIALES_INVALIDAS');
  });

  it('clasifica cualquier otro error como ERROR', () => {
    expect(clasificarErrorCredenciales(new Error('timeout de red'))).toBe('ERROR');
  });

  it('clasifica un valor que no es Error como ERROR', () => {
    expect(clasificarErrorCredenciales('algo raro')).toBe('ERROR');
  });
});
```

(Ajustar el `import` existente al tope del archivo para agregar `clasificarErrorCredenciales` a la lista — no duplicar el `import` de `conErroresDeSesion, SesionNoIniciada`.)

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/erroresSesion.test.ts -t "clasificarErrorCredenciales"`
Expected: FAIL — `clasificarErrorCredenciales` no existe todavía.

- [ ] **Step 3: Implementar**

Agregar al final de `src/erroresSesion.ts`:

```typescript
// Distingue "el SII rechazó la clave/RUT" de cualquier otro fallo (timeout, red,
// browser caído). Mismo criterio que ya usaba sii_iniciar_sesion inline; se
// extrae acá porque el endpoint de validación (Task 4) necesita la misma
// clasificación y una segunda copia inline sería la misma duplicación que ya
// se resolvió una vez para conScraper.
export function clasificarErrorCredenciales(e: unknown): 'CREDENCIALES_INVALIDAS' | 'ERROR' {
  const mensaje = e instanceof Error ? e.message : String(e);
  return mensaje.includes('El SII rechazó la autenticación') ? 'CREDENCIALES_INVALIDAS' : 'ERROR';
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npx jest tests/erroresSesion.test.ts`
Expected: PASS

- [ ] **Step 5: Refactorizar `bienesRaices.ts` para usar la función extraída**

En `src/tools/bienesRaices.ts`, cambiar el import:

```typescript
import { crearConScraper, clasificarErrorCredenciales } from '../erroresSesion';
```

Y reemplazar dentro de `sii_iniciar_sesion`:

```typescript
      try {
        await registro.ejecutar(rut, sesion => sesion.authenticateOnly());
      } catch (e) {
        credenciales.borrar(rut);
        const error = clasificarErrorCredenciales(e);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }] };
      }
```

(Elimina las líneas que armaban `mensaje` y `error` a mano.)

- [ ] **Step 6: Correr los tests de la tool afectada y la suite completa**

Run: `npx jest tests/tools/sesion.test.ts && npm test`
Expected: PASS — el test `iniciar sesión con credenciales rechazadas por el SII devuelve CREDENCIALES_INVALIDAS` sigue pasando sin cambios (mismo mensaje de error, misma clasificación).

- [ ] **Step 7: Commit**

```bash
git add src/erroresSesion.ts src/tools/bienesRaices.ts tests/erroresSesion.test.ts
git commit -m "refactor: extraer clasificarErrorCredenciales para no duplicarla en el endpoint de validación"
```

---

### Task 3: Comparación de API key en tiempo constante

**Files:**
- Create: `src/apiKey.ts`
- Test: `tests/apiKey.test.ts`

**Interfaces:**
- Consumes: `crypto.timingSafeEqual` (built-in de Node, sin dependencia nueva).
- Produces: `compararApiKey(recibida: string, esperada: string): boolean`. Task 5 (`crearServidorHttp`) consume esta función.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/apiKey.test.ts`:

```typescript
import { compararApiKey } from '../src/apiKey';

describe('compararApiKey', () => {
  it('true cuando ambas coinciden', () => {
    expect(compararApiKey('clave-secreta', 'clave-secreta')).toBe(true);
  });

  it('false cuando difieren con la misma longitud', () => {
    expect(compararApiKey('clave-secretx', 'clave-secreta')).toBe(false);
  });

  it('false cuando difieren en longitud (no debe lanzar)', () => {
    expect(compararApiKey('corta', 'clave-mucho-mas-larga')).toBe(false);
  });

  it('false cuando la recibida está vacía', () => {
    expect(compararApiKey('', 'clave-secreta')).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/apiKey.test.ts`
Expected: FAIL — el módulo `src/apiKey.ts` no existe.

- [ ] **Step 3: Implementar**

Crear `src/apiKey.ts`:

```typescript
import { timingSafeEqual } from 'crypto';

// Compara en tiempo constante para no filtrar por timing cuánto prefijo de la
// API key coincide. crypto.timingSafeEqual lanza si los buffers tienen
// longitud distinta, así que ese caso se resuelve aparte — pero igual se hace
// una comparación de la misma duración (contra sí misma) para no introducir
// un camino más rápido cuando la longitud no calza.
export function compararApiKey(recibida: string, esperada: string): boolean {
  const bufRecibida = Buffer.from(recibida);
  const bufEsperada = Buffer.from(esperada);

  if (bufRecibida.length !== bufEsperada.length) {
    timingSafeEqual(bufEsperada, bufEsperada);
    return false;
  }

  return timingSafeEqual(bufRecibida, bufEsperada);
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npx jest tests/apiKey.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/apiKey.ts tests/apiKey.test.ts
git commit -m "feat: comparación de API key en tiempo constante"
```

---

### Task 4: `validarClave` — lógica de negocio sin HTTP

**Files:**
- Create: `src/httpServer.ts` (solo `validarClave` en esta task; `crearServidorHttp` llega en Task 5)
- Test: `tests/httpServer.test.ts`

**Interfaces:**
- Consumes: `RegistroSesiones<SessionManager>.ejecutar(rut, fn)` (ya existe, `src/registroSesiones.ts`), `ProveedorCredencialesRuntime.guardar/borrar` (ya existe, `src/credencialesRuntime.ts`), `clasificarErrorCredenciales` (Task 2).
- Produces: `validarClave(rut: string, clave: string, registro: RegistroSesiones<SessionManager>, credenciales: ProveedorCredencialesRuntime): Promise<{ ok: true } | { ok: false; error: 'CREDENCIALES_INVALIDAS' | 'ERROR' }>`. Task 5 consume esta función.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/httpServer.test.ts`:

```typescript
import { validarClave } from '../src/httpServer';
import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';
import { RegistroSesiones } from '../src/registroSesiones';

function armarRegistro(sesion: { authenticateOnly: jest.Mock; logout: jest.Mock }) {
  return {
    ejecutar: (_rut: string, fn: any) => fn(sesion),
  } as unknown as RegistroSesiones<any>;
}

describe('validarClave', () => {
  it('clave correcta: responde ok:true y deja logout+borrar hechos', async () => {
    const authenticateOnly = jest.fn().mockResolvedValue(undefined);
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'secreta', registro, credenciales);

    expect(resultado).toEqual({ ok: true });
    expect(logout).toHaveBeenCalled();
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow();
  });

  it('clave rechazada por el SII: responde CREDENCIALES_INVALIDAS y limpia igual', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(
      new Error('El SII rechazó la autenticación: clave incorrecta')
    );
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'mala', registro, credenciales);

    expect(resultado).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
    expect(logout).toHaveBeenCalled();
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow();
  });

  it('fallo de infraestructura: responde ERROR y limpia igual', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'x', registro, credenciales);

    expect(resultado).toEqual({ ok: false, error: 'ERROR' });
    expect(logout).toHaveBeenCalled();
  });

  it('logout corre aunque authenticateOnly lance (try/finally, no encadenado)', async () => {
    const orden: string[] = [];
    const authenticateOnly = jest.fn().mockImplementation(async () => {
      orden.push('authenticateOnly');
      throw new Error('boom');
    });
    const logout = jest.fn().mockImplementation(async () => {
      orden.push('logout');
    });
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    await validarClave('11.111.111-1', 'x', registro, credenciales);

    expect(orden).toEqual(['authenticateOnly', 'logout']);
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `npx jest tests/httpServer.test.ts`
Expected: FAIL — `src/httpServer.ts` no existe.

- [ ] **Step 3: Implementar**

Crear `src/httpServer.ts`:

```typescript
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { clasificarErrorCredenciales } from './erroresSesion';

export type ResultadoValidacion =
  | { ok: true }
  | { ok: false; error: 'CREDENCIALES_INVALIDAS' | 'ERROR' };

// Valida una clave tributaria contra el SII real, de una sola pasada: autentica,
// confirma el resultado y cierra todo antes de devolver la respuesta — a
// diferencia de sii_iniciar_sesion, no deja nada operable.
//
// authenticateOnly() y logout() corren en el MISMO turno de la cola por RUT
// (dentro del mismo registro.ejecutar), con try/finally. Un logout() como una
// llamada a registro.ejecutar aparte quedaría encolado detrás de cualquier
// operación que haya entrado para ese RUT mientras tanto — ver la sección
// "Timeout" del spec.
export async function validarClave(
  rut: string,
  clave: string,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): Promise<ResultadoValidacion> {
  credenciales.guardar(rut, clave);
  try {
    await registro.ejecutar(rut, async sesion => {
      try {
        await sesion.authenticateOnly();
      } finally {
        await sesion.logout();
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: clasificarErrorCredenciales(e) };
  } finally {
    credenciales.borrar(rut);
  }
}
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `npx jest tests/httpServer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/httpServer.ts tests/httpServer.test.ts
git commit -m "feat: validarClave — autentica y limpia en el mismo turno de cola por RUT"
```

---

### Task 5: `crearServidorHttp` — routing HTTP sobre `validarClave`

**Files:**
- Modify: `src/httpServer.ts`
- Test: `tests/httpServer.test.ts`

**Interfaces:**
- Consumes: `validarClave` (Task 4), `compararApiKey` (Task 3).
- Produces: `crearServidorHttp(registro: RegistroSesiones<SessionManager>, credenciales: ProveedorCredencialesRuntime, apiKey: string): http.Server`. Task 6 (entrypoint) consume esta función.

- [ ] **Step 1: Escribir los tests que fallan**

Agregar a `tests/httpServer.test.ts` (mismo archivo, nuevo `describe`, usando `http` nativo como cliente — sin dependencias nuevas):

```typescript
import * as http from 'http';
import { crearServidorHttp } from '../src/httpServer';

function request(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/validar-clave', headers: opts.headers },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('crearServidorHttp', () => {
  const API_KEY = 'clave-del-servicio';
  let server: http.Server;
  let port: number;

  function armarRegistroOk() {
    return {
      ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly: jest.fn().mockResolvedValue(undefined), logout: jest.fn().mockResolvedValue(undefined) }),
    } as any;
  }

  beforeEach(done => {
    const registro = armarRegistroOk();
    const credenciales = new ProveedorCredencialesRuntime();
    server = crearServidorHttp(registro, credenciales, API_KEY);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach(done => {
    server.close(done);
  });

  it('clave correcta con auth válida responde 200 {ok:true}', async () => {
    const res = await request(port, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rut: '11.111.111-1', clave: 'secreta' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('sin Authorization responde 401', async () => {
    const res = await request(port, { body: JSON.stringify({ rut: '1', clave: '2' }) });
    expect(res.status).toBe(401);
  });

  it('con API key incorrecta responde 401', async () => {
    const res = await request(port, {
      headers: { Authorization: 'Bearer clave-equivocada' },
      body: JSON.stringify({ rut: '1', clave: '2' }),
    });
    expect(res.status).toBe(401);
  });

  it('body sin clave responde 400', async () => {
    const res = await request(port, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ rut: '1' }),
    });
    expect(res.status).toBe(400);
  });

  it('body no-JSON responde 400', async () => {
    const res = await request(port, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: 'esto no es json',
    });
    expect(res.status).toBe(400);
  });

  it('ruta desconocida responde 404', async () => {
    const res = await request(port, {
      path: '/otra-cosa',
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `npx jest tests/httpServer.test.ts -t "crearServidorHttp"`
Expected: FAIL — `crearServidorHttp` no existe todavía.

- [ ] **Step 3: Implementar**

Agregar al final de `src/httpServer.ts`:

```typescript
import * as http from 'http';
import { compararApiKey } from './apiKey';

function leerBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', chunk => { datos += chunk; });
    req.on('end', () => resolve(datos));
    req.on('error', reject);
  });
}

function responderJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Servidor HTTP mínimo, sin framework: un solo endpoint. Cada request abre y
// cierra su propia sesión SII (ver validarClave) — no hay estado entre
// requests más que lo que ya vive en `registro`/`credenciales`.
export function crearServidorHttp(
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime,
  apiKey: string
): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/validar-clave') {
      res.writeHead(404).end();
      return;
    }

    const authHeader = req.headers.authorization;
    const recibida = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : '';

    if (!compararApiKey(recibida, apiKey)) {
      responderJson(res, 401, { error: 'UNAUTHORIZED' });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await leerBody(req));
    } catch {
      responderJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }

    const { rut, clave } = (body ?? {}) as { rut?: unknown; clave?: unknown };
    if (typeof rut !== 'string' || typeof clave !== 'string') {
      responderJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }

    const resultado = await validarClave(rut, clave, registro, credenciales);
    responderJson(res, 200, resultado);
  });
}
```

(El `import { RegistroSesiones } ...` y `import { SessionManager } ...` ya están al tope del archivo desde Task 4 — no duplicarlos.)

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `npx jest tests/httpServer.test.ts`
Expected: PASS

- [ ] **Step 5: Correr la suite completa**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/httpServer.ts tests/httpServer.test.ts
git commit -m "feat: crearServidorHttp — endpoint POST /validar-clave con auth por API key"
```

---

### Task 6: Entrypoint del proceso (`src/httpServerIndex.ts`) y wiring

**Files:**
- Create: `src/httpServerIndex.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `crearServidorHttp` (Task 5), `Browser` con `sessionId` (Task 1), `RegistroSesiones`, `SessionManager`, `ProveedorCredencialesRuntime`.
- Produces: proceso ejecutable vía `node dist/src/httpServerIndex.js` (o `npm run start:validar-clave`). No exporta nada para otros módulos — es un binario, como `src/index.ts`.

Este archivo arma su propio `RegistroSesiones` (no reusa `crearRegistroSesionesSii` de `src/registroSesionesSii.ts`) porque cada RUT necesita su **propio** `Browser` con `sessionId = rut`, para el aislamiento de `--session` — `crearRegistroSesionesSii` comparte un único `Browser` entre todos los RUT, que es lo correcto para el MCP stdio local pero no para este proceso (ver spec, "Aislamiento real entre RUTs").

- [ ] **Step 1: Crear el archivo**

Crear `src/httpServerIndex.ts`:

```typescript
import 'dotenv/config';
import { Browser } from './browser';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearServidorHttp } from './httpServer';

function requireEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) {
    throw new Error(`Variable de entorno requerida no encontrada: ${nombre}`);
  }
  return valor;
}

const apiKey = requireEnv('VALIDACION_API_KEY');
const port = Number(process.env.VALIDACION_PORT ?? 8787);

const credenciales = new ProveedorCredencialesRuntime();

// A diferencia de crearRegistroSesionesSii (src/registroSesionesSii.ts), acá
// cada RUT recibe su PROPIO Browser con sessionId = rut, para que
// agent-browser aísle cookies/tabs/refs entre validaciones concurrentes de
// RUTs distintos (ver spec: "Aislamiento real entre RUTs").
const registro = new RegistroSesiones<SessionManager>(async rut => {
  const config = await credenciales.para(rut);
  return new SessionManager(config, new Browser(rut));
});

const server = crearServidorHttp(registro, credenciales, apiKey);
server.listen(port, () => {
  console.log(`Servicio de validación de clave escuchando en :${port}`);
});
```

- [ ] **Step 2: Verificar que compila**

Run: `npm run build`
Expected: sin errores de TypeScript.

- [ ] **Step 3: Agregar el script a `package.json`**

En `package.json`, dentro de `"scripts"`, agregar (después de `"start"`):

```json
    "start:validar-clave": "node dist/src/httpServerIndex.js",
```

- [ ] **Step 4: Correr la suite completa una vez más**

Run: `npm test`
Expected: PASS — este archivo no tiene test propio (es un script de bootstrap sin lógica condicional; la lógica que sí se testea vive en `httpServer.ts`, ya cubierta en Task 4 y 5).

- [ ] **Step 5: Commit**

```bash
git add src/httpServerIndex.ts package.json
git commit -m "feat: entrypoint del servicio de validación de clave (src/httpServerIndex.ts)"
```

---

### Task 7: Verificación end-to-end manual

**Files:** ninguno (sólo comandos, no hay código en esta task)

- [ ] **Step 1: Levantar el servicio localmente**

Requiere `agent-browser` instalado (`npm install -g agent-browser && agent-browser install`, ya documentado en el repo para el MCP stdio).

```bash
npm run build
VALIDACION_API_KEY=test-key VALIDACION_PORT=8787 npm run start:validar-clave
```

- [ ] **Step 2: Probar con una clave (usar un RUT/clave de prueba reales o de un ambiente de test del SII, nunca credenciales de producción reales en texto plano en la terminal sin necesidad)**

```bash
curl -s -X POST http://localhost:8787/validar-clave \
  -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"la-clave-a-probar"}'
```

Expected: `{"ok":true}` si la clave es correcta, `{"ok":false,"error":"CREDENCIALES_INVALIDAS"}` si no.

- [ ] **Step 3: Confirmar que no queda sesión abierta**

Repetir el mismo `curl` inmediatamente después. Si el SII bloqueara sesiones simultáneas del mismo RUT (01.01.190.500.720.27), este segundo llamado fallaría con `ERROR` si la primera sesión no se hubiera cerrado. Debe responder igual que la primera vez — confirma que `logout()` corrió antes de la respuesta anterior.

- [ ] **Step 4: Probar los caminos de error de transporte**

```bash
# Sin Authorization -> 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/validar-clave \
  -d '{"rut":"1","clave":"2"}'

# API key incorrecta -> 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/validar-clave \
  -H "Authorization: Bearer key-equivocada" -d '{"rut":"1","clave":"2"}'

# Body inválido -> 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8787/validar-clave \
  -H "Authorization: Bearer test-key" -d '{"rut":"1"}'
```

Expected: `401`, `401`, `400` respectivamente.

- [ ] **Step 5: Apagar el servicio de prueba**

`Ctrl+C` en la terminal donde corre `npm run start:validar-clave`.

No hay commit en esta task — es sólo verificación manual antes de dar el trabajo por terminado.

---

## Self-Review

**Cobertura del spec:**
- Proceso separado del MCP stdio → Task 6 (`httpServerIndex.ts` es su propio entrypoint, `server.ts`/`index.ts` no se tocan).
- Aislamiento por `--session <rut>` → Task 1 (Browser) + Task 6 (cada RUT arma su propio `Browser(rut)`).
- Validación de una sola pasada, sin sesión persistente → Task 4 (`validarClave`: `guardar` → `authenticateOnly`+`logout` en el mismo turno → `borrar` en `finally`).
- Contrato del endpoint (`{ok}`, 401, 400, clasificación de error) → Task 5.
- Comparación de API key en tiempo constante (fix aplicado a la spec) → Task 3.
- Cleanup no depende de un `Promise.race`/timeout externo (fix aplicado a la spec) → Task 4, `try/finally` dentro del mismo `registro.ejecutar`.
- "La clave nunca se loguea" → ningún `console.log`/error de la implementación incluye `clave` en ningún punto (revisar en code review si se agregan logs más adelante).
- Fuera de alcance (wiring de Tributy, migrar `Browser` del MCP stdio, rotación de API key, rate limiting) → correctamente no incluido en ninguna task.

**Placeholders:** ninguno — cada step tiene código completo, no hay "TBD" ni "similar a la Task N" sin repetir el código.

**Consistencia de tipos:** `ResultadoValidacion` se define en Task 4 y se usa igual en Task 5 (`Promise<ResultadoValidacion>` implícito en el `await validarClave(...)`). `RegistroSesiones<SessionManager>` y `ProveedorCredencialesRuntime` se pasan con la misma firma en `validarClave`, `crearServidorHttp` y `httpServerIndex.ts`.
