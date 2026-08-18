# Login por sesión — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el `SessionManager` único y fijo por proceso por un
registro multi-tenant por RUT, con una tool `sii_iniciar_sesion` que recibe
credenciales en runtime.

**Architecture:** `server.ts` arma un `ProveedorCredencialesRuntime` (nuevo)
+ `crearRegistroSesionesSii` (ya existe) una sola vez al boot. Cada tool deja
de recibir un scraper pre-construido con sesión fija; en su lugar recibe el
`RegistroSesiones<SessionManager>` y, en el handler, resuelve la sesión del
`rut` recibido con `registro.ejecutar(rut, sesion => { ...construir scraper con esa sesión...; return scraper.metodo(...) })`.

**Tech Stack:** TypeScript, Vitest, MCP SDK (`@modelcontextprotocol/sdk`).

**Spec:** `docs/superpowers/specs/2026-08-18-login-por-sesion-design.md`

## Global Constraints

- RUT siempre normalizado con `normalizar()` de `src/credenciales.ts:17-18`
  (`rut.replace(/[^0-9kK]/g, '').toUpperCase()`) antes de usarse como clave
  de cualquier mapa o de `registro.ejecutar`.
- Ninguna tool hace login implícito. Sin sesión → `SESION_NO_INICIADA`.
  Sesión vencida a mitad de operación → `SESION_EXPIRADA`.
- La clave tributaria nunca se loguea ni vuelve en ningún output de tool.
- `sii_cerrar_sesion` borra también la credencial guardada (no sólo cierra
  el `SessionManager`).
- El `Browser` sigue siendo único por proceso, compartido por todas las
  sesiones (no cambia).

---

### Task 1: `ProveedorCredencialesRuntime`

**Files:**
- Create: `src/credencialesRuntime.ts`
- Test: `tests/credencialesRuntime.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ProveedorCredencialesRuntime implements ProveedorCredenciales {
    guardar(rut: string, clave: string): void
    borrar(rut: string): void
    para(rut: string): Promise<SiiConfig>  // ya en la interfaz ProveedorCredenciales
  }
  ```

- [ ] **Step 1: Escribir tests que fallan**

```ts
import { describe, it, expect } from 'vitest';
import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';
import { AuthStrategy } from '../src/env';

describe('ProveedorCredencialesRuntime', () => {
  it('guarda y devuelve la config de un RUT', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    proveedor.guardar('11.111.111-1', 'clave-secreta');
    const config = await proveedor.para('11.111.111-1');
    expect(config.rut).toBe('11.111.111-1');
    expect(config.clave).toBe('clave-secreta');
    expect(config.strategy).toBe(AuthStrategy.Clave);
  });

  it('normaliza el RUT: distintos formatos resuelven la misma entrada', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    proveedor.guardar('11.111.111-1', 'clave-secreta');
    const config = await proveedor.para('111111111');
    expect(config.clave).toBe('clave-secreta');
  });

  it('para() de un RUT no guardado lanza', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    await expect(proveedor.para('22.222.222-2')).rejects.toThrow();
  });

  it('borrar() elimina la entrada: para() posterior lanza', async () => {
    const proveedor = new ProveedorCredencialesRuntime();
    proveedor.guardar('11.111.111-1', 'clave-secreta');
    proveedor.borrar('11.111.111-1');
    await expect(proveedor.para('11.111.111-1')).rejects.toThrow();
  });

  it('borrar() de un RUT no guardado no lanza', () => {
    const proveedor = new ProveedorCredencialesRuntime();
    expect(() => proveedor.borrar('99.999.999-9')).not.toThrow();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/credencialesRuntime.test.ts`
Expected: FAIL — el módulo `../src/credencialesRuntime` no existe.

- [ ] **Step 3: Implementar**

```ts
// src/credencialesRuntime.ts
import { AuthStrategy, SiiConfig } from './env';
import { ProveedorCredenciales } from './credenciales';

function normalizar(rut: string): string {
  return rut.replace(/[^0-9kK]/g, '').toUpperCase();
}

// Credenciales que llegan en tiempo de ejecución vía sii_iniciar_sesion, no de
// env. Vive sólo en memoria del proceso: nunca se persiste a disco. A
// diferencia de CredencialesEnMemoria (que se arma una sola vez al boot desde
// env), este proveedor tiene métodos de escritura porque la tool lo alimenta
// mientras el servidor corre.
export class ProveedorCredencialesRuntime implements ProveedorCredenciales {
  private porRut = new Map<string, SiiConfig>();

  guardar(rut: string, clave: string): void {
    this.porRut.set(normalizar(rut), {
      rut,
      clave,
      strategy: AuthStrategy.Clave,
    });
  }

  borrar(rut: string): void {
    this.porRut.delete(normalizar(rut));
  }

  async para(rut: string): Promise<SiiConfig> {
    const config = this.porRut.get(normalizar(rut));
    if (!config) {
      throw new Error(`No hay sesión iniciada para el RUT ${rut}. Llamá sii_iniciar_sesion primero.`);
    }
    return config;
  }
}
```

Antes de escribir, leer `src/env.ts` para confirmar la forma exacta de
`SiiConfig` y `AuthStrategy` (campos requeridos/opcionales) y ajustar el
objeto devuelto por `guardar()` si hace falta.

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run tests/credencialesRuntime.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/credencialesRuntime.ts tests/credencialesRuntime.test.ts
git commit -m "feat: ProveedorCredencialesRuntime para credenciales en tiempo de ejecución"
```

---

### Task 2: Errores tipados `SESION_NO_INICIADA` / `SESION_EXPIRADA`

**Files:**
- Modify: `src/session.ts` (no cambia lógica interna, sólo se documenta el
  contrato de errores que ya lanza `authenticate()`/`getSession()` — ver
  Step 1)
- Create: `src/erroresSesion.ts`
- Test: `tests/erroresSesion.test.ts`

**Interfaces:**
- Consumes: nada nuevo de `session.ts` (los errores que ya lanza se
  re-clasifican del lado de quien llama, no se tocan sus mensajes).
- Produces:
  ```ts
  export class SesionNoIniciada extends Error {}
  export class SesionExpirada extends Error {}

  // Envuelve `fn` (una llamada a `registro.ejecutar`) y traduce el rechazo de
  // `ProveedorCredencialesRuntime.para()` (RUT nunca logueado) a
  // SesionNoIniciada. No hay hoy una señal explícita de "sesión vencida a
  // mitad de operación" del lado del SessionManager —RegistroSesiones cachea
  // la instancia y SessionManager.authenticate() reautentica sola dentro del
  // TTL— así que SesionExpirada queda reservada para cuando session.ts la
  // emita explícitamente en un futuro spec; por ahora este wrapper sólo
  // traduce el caso de RUT nunca logueado.
  export async function conErroresDeSesion<T>(fn: () => Promise<T>): Promise<T>
  ```

- [ ] **Step 1: Escribir tests que fallan**

```ts
import { describe, it, expect } from 'vitest';
import { conErroresDeSesion, SesionNoIniciada } from '../src/erroresSesion';

describe('conErroresDeSesion', () => {
  it('traduce el rechazo de credenciales no encontradas a SesionNoIniciada', async () => {
    await expect(
      conErroresDeSesion(() => Promise.reject(new Error('No hay sesión iniciada para el RUT 11.111.111-1. Llamá sii_iniciar_sesion primero.')))
    ).rejects.toThrow(SesionNoIniciada);
  });

  it('deja pasar el resultado de éxito sin tocarlo', async () => {
    const resultado = await conErroresDeSesion(() => Promise.resolve('ok'));
    expect(resultado).toBe('ok');
  });

  it('deja pasar sin traducir un error que no es de sesión', async () => {
    await expect(
      conErroresDeSesion(() => Promise.reject(new Error('otro fallo, no de sesión')))
    ).rejects.toThrow('otro fallo, no de sesión');
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/erroresSesion.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

```ts
// src/erroresSesion.ts
export class SesionNoIniciada extends Error {}
export class SesionExpirada extends Error {}

const MARCA_SIN_SESION = 'Llamá sii_iniciar_sesion primero';

export async function conErroresDeSesion<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && e.message.includes(MARCA_SIN_SESION)) {
      throw new SesionNoIniciada(e.message);
    }
    throw e;
  }
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run tests/erroresSesion.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/erroresSesion.ts tests/erroresSesion.test.ts
git commit -m "feat: clasificar errores de sesión (SesionNoIniciada/SesionExpirada)"
```

---

### Task 3: Tool `sii_iniciar_sesion` y `sii_cerrar_sesion(rut)`

**Files:**
- Modify: `src/tools/bienesRaices.ts` (ahí vive `registerSesionTools`)
- Test: `tests/tools/sesion.test.ts` (crear carpeta `tests/tools/` si no existe)

**Interfaces:**
- Consumes: `RegistroSesiones<SessionManager>` (`src/registroSesiones.ts`,
  método `ejecutar(rut, fn)`), `ProveedorCredencialesRuntime` (Task 1,
  métodos `guardar`, `borrar`), `SessionManager.authenticateOnly()` (ya
  existe en `src/session.ts:214-216`), `SessionManager.logout()` (ya existe,
  `src/session.ts:238-247`).
- Produces: `registerSesionTools(server, registro, proveedorRuntime)` —
  cambia de firma: antes tomaba `session: SessionManager` fijo, ahora toma
  el registro + el proveedor.

- [ ] **Step 1: Escribir tests que fallan**

```ts
// tests/tools/sesion.test.ts
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSesionTools } from '../../src/tools/bienesRaices';
import { ProveedorCredencialesRuntime } from '../../src/credencialesRuntime';
import { RegistroSesiones } from '../../src/registroSesiones';

// Handlers registrados quedan accesibles vía server._registeredTools en el
// SDK de MCP para tests — si esa API cambió, revisar
// tests/registroSesionesSii.test.ts (ya existente) para el patrón de mock
// vigente en este repo.
function capturarHandlers(server: McpServer) {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const originalTool = server.tool.bind(server);
  vi.spyOn(server, 'tool').mockImplementation((name: any, ...rest: any[]) => {
    const handler = rest[rest.length - 1];
    handlers.set(name, handler);
    return originalTool(name, ...rest);
  });
  return handlers;
}

describe('sii_iniciar_sesion / sii_cerrar_sesion', () => {
  it('iniciar sesión con credenciales válidas guarda la credencial y autentica', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handlers = capturarHandlers(server);
    const proveedor = new ProveedorCredencialesRuntime();
    const authenticateOnly = vi.fn().mockResolvedValue(undefined);
    const registro = { ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly, logout: vi.fn() }) } as unknown as RegistroSesiones<any>;

    registerSesionTools(server, registro, proveedor);
    const resultado = await handlers.get('sii_iniciar_sesion')!({ rut: '11.111.111-1', clave: 'secreta' });

    expect(authenticateOnly).toHaveBeenCalled();
    expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: true, rut: '11.111.111-1' });
    await expect(proveedor.para('11.111.111-1')).resolves.toMatchObject({ clave: 'secreta' });
  });

  it('iniciar sesión con credenciales rechazadas por el SII devuelve CREDENCIALES_INVALIDAS', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handlers = capturarHandlers(server);
    const proveedor = new ProveedorCredencialesRuntime();
    const authenticateOnly = vi.fn().mockRejectedValue(new Error('El SII rechazó la autenticación: clave incorrecta'));
    const registro = { ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly, logout: vi.fn() }) } as unknown as RegistroSesiones<any>;

    registerSesionTools(server, registro, proveedor);
    const resultado = await handlers.get('sii_iniciar_sesion')!({ rut: '11.111.111-1', clave: 'mala' });

    const parsed = JSON.parse(resultado.content[0].text);
    expect(parsed).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
  });

  it('cerrar sesión hace logout y borra la credencial del proveedor', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handlers = capturarHandlers(server);
    const proveedor = new ProveedorCredencialesRuntime();
    proveedor.guardar('11.111.111-1', 'secreta');
    const logout = vi.fn().mockResolvedValue(undefined);
    const registro = { ejecutar: (_rut: string, fn: any) => fn({ authenticateOnly: vi.fn(), logout }) } as unknown as RegistroSesiones<any>;

    registerSesionTools(server, registro, proveedor);
    await handlers.get('sii_cerrar_sesion')!({ rut: '11.111.111-1' });

    expect(logout).toHaveBeenCalled();
    await expect(proveedor.para('11.111.111-1')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/tools/sesion.test.ts`
Expected: FAIL — `registerSesionTools` todavía tiene la firma vieja
`(server, session)`.

- [ ] **Step 3: Implementar**

Reemplazar en `src/tools/bienesRaices.ts` el `registerSesionTools` existente
(líneas 5-17) por:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BienesRaicesScraper } from '../scrapers/bienesRaices';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';

export function registerSesionTools(
  server: McpServer,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  server.tool(
    'sii_iniciar_sesion',
    'Inicia sesión en el SII con el RUT y clave tributaria de una persona. Necesario antes de ' +
    'llamar cualquier otra tool con ese mismo RUT. Reintentar con el mismo RUT no abre una ' +
    'sesión nueva mientras la anterior siga vigente (dentro de 2 horas).',
    {
      rut: z.string().describe('RUT de la persona, con o sin puntos/guión'),
      clave: z.string().describe('Clave tributaria del SII de esa persona'),
    },
    async ({ rut, clave }) => {
      credenciales.guardar(rut, clave);
      try {
        await registro.ejecutar(rut, sesion => sesion.authenticateOnly());
      } catch (e) {
        credenciales.borrar(rut);
        const mensaje = e instanceof Error ? e.message : String(e);
        const error = mensaje.includes('El SII rechazó la autenticación')
          ? 'CREDENCIALES_INVALIDAS'
          : 'ERROR';
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, rut }) }] };
    }
  );

  server.tool(
    'sii_cerrar_sesion',
    'Cierra la sesión abierta en el SII para un RUT y olvida su credencial. El SII limita ' +
    'cuántas sesiones simultáneas puede tener un RUT y las bloquea al superarlas ' +
    '(error 01.01.190.500.720.27), así que conviene cerrarla al terminar.',
    {
      rut: z.string().describe('RUT de la persona cuya sesión se cierra'),
    },
    async ({ rut }) => {
      await registro.ejecutar(rut, sesion => sesion.logout());
      credenciales.borrar(rut);
      return {
        content: [{ type: 'text' as const, text: `Sesión cerrada en el SII para ${rut}.` }],
      };
    }
  );
}

export function registerBienesRaicesTools(server: McpServer, scraper: BienesRaicesScraper): void {
  server.tool(
    'sii_persona_list_bienes_raices',
    'Lista los bienes raíces (propiedades) del RUT persona autenticado en el SII, con comuna, ROL, dirección, destino, datos de inscripción, porcentaje de derechos y avalúo fiscal. Incluye un resumen con total de propiedades, solicitudes, notificaciones, afectación a sobretasa y beneficio de adulto mayor. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    {},
    async () => {
      const result = await scraper.listBienesRaices();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
```

`registerBienesRaicesTools` (la otra tool del archivo) queda IGUAL — se
toca en Task 4 junto con el resto de las tools de dominio, para no mezclar
en un mismo commit el cableado de sesión con el de scrapers por RUT.

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run tests/tools/sesion.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/tools/bienesRaices.ts tests/tools/sesion.test.ts
git commit -m "feat: tool sii_iniciar_sesion y sii_cerrar_sesion(rut)"
```

---

### Task 4: Cablear `server.ts` y las tools de dominio al registro por RUT

**Files:**
- Modify: `src/server.ts`
- Modify: `src/tools/bienesRaices.ts` (`registerBienesRaicesTools`)
- Modify: `src/tools/mipyme.ts`
- Modify: `src/tools/dte.ts`
- Modify: `src/tools/bhe.ts`
- Modify: `src/tools/renta.ts`
- Modify: `src/tools/rcv.ts`
- Test: `tests/tools/mipyme.test.ts` (uno representativo, per Testing section
  del spec — no hace falta repetir en las 6 tools de dominio)

**Interfaces:**
- Consumes: `RegistroSesiones<SessionManager>.ejecutar(rut, fn)` (ya
  existente), `conErroresDeSesion` (Task 2), `SessionManager` (constructor
  ya usado por cada scraper).
- Produces: cada `registerXTools(server, registro)` — cambia de firma:
  antes tomaba el scraper ya construido, ahora toma
  `RegistroSesiones<SessionManager>` y arma el scraper por llamada dentro
  del handler.

Este es el task de mayor superficie. El patrón se repite igual en las 6
tools de dominio: agregar `rut: z.string()` como primer parámetro de cada
tool (antes de `empresa_rut` donde exista), y envolver el cuerpo del handler
así:

```ts
async ({ rut, ...resto }) => {
  const resultado = await conErroresDeSesion(() =>
    registro.ejecutar(rut, async sesion => {
      const http = new SiiHttpClient(sesion);       // o BienesRaicesScraper(browser, sesion), etc — el que corresponda por dominio
      const scraper = new XScraper(http, sesion);
      return scraper.metodoOriginal(resto...);
    })
  ).catch(e => {
    if (e instanceof SesionNoIniciada) return { __error: 'SESION_NO_INICIADA' };
    throw e;
  });
  if (resultado && '__error' in resultado) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: resultado.__error }) }] };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(resultado, null, 2) }] };
}
```

Ajustar por archivo qué scraper(s) construir (`bhe.ts` usa `BheScraper`
sobre `SiiHttpClient`, `dte.ts` usa `DteScraper`, etc. — mismo patrón que
hoy tiene `server.ts:26-37`, sólo que ahora ocurre por-llamada en vez de una
vez al boot). El `Browser` sigue siendo el único del proceso, pasado por
closure desde `server.ts` a cada `registerXTools`.

- [ ] **Step 1: Escribir test que falla (representativo — `sii_mipyme_list_empresas`)**

```ts
// tests/tools/mipyme.test.ts
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMipymeTools } from '../../src/tools/mipyme';
import { RegistroSesiones } from '../../src/registroSesiones';

function capturarHandlers(server: McpServer) {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  vi.spyOn(server, 'tool').mockImplementation((name: any, ...rest: any[]) => {
    handlers.set(name, rest[rest.length - 1]);
    return server;
  });
  return handlers;
}

describe('sii_mipyme_list_empresas con rut', () => {
  it('sin sesión iniciada devuelve SESION_NO_INICIADA', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handlers = capturarHandlers(server);
    const registro = {
      ejecutar: () => Promise.reject(new Error('No hay sesión iniciada para el RUT 11.111.111-1. Llamá sii_iniciar_sesion primero.')),
    } as unknown as RegistroSesiones<any>;

    registerMipymeTools(server, registro);
    const resultado = await handlers.get('sii_mipyme_list_empresas')!({ rut: '11.111.111-1' });

    expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('con sesión resuelve la sesión correcta y llama al scraper', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const handlers = capturarHandlers(server);
    const sesionFake = {};
    const registro = {
      ejecutar: (_rut: string, fn: any) => fn(sesionFake),
    } as unknown as RegistroSesiones<any>;

    registerMipymeTools(server, registro);
    const resultado = await handlers.get('sii_mipyme_list_empresas')!({ rut: '11.111.111-1' });

    // No se mockea SiiHttpClient/MipymeHttpScraper acá a propósito: si el
    // wiring real llega a pegarle a la red, este test falla por timeout en
    // vez de dar un falso verde. Ajustar con vi.mock si el scraper real
    // hace una llamada de red en listEmpresas() antes de poder mockearlo.
    expect(resultado).toBeDefined();
  });
});
```

Nota para quien implemente: la segunda prueba puede necesitar
`vi.mock('../../src/scrapers/mipymeHttp')` si `listEmpresas()` intenta una
llamada HTTP real apenas se construye el scraper — revisar
`src/scrapers/mipymeHttp.ts` antes de fijar el mock exacto.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/tools/mipyme.test.ts`
Expected: FAIL — `registerMipymeTools` todavía toma un scraper pre-construido,
no un `RegistroSesiones`.

- [ ] **Step 3: Implementar**

3a. Modificar `src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Browser } from './browser';
import { registerMipymeTools } from './tools/mipyme';
import { registerDteTools } from './tools/dte';
import { registerBienesRaicesTools, registerSesionTools } from './tools/bienesRaices';
import { registerBheTools } from './tools/bhe';
import { registerRentaTools } from './tools/renta';
import { registerRcvTools } from './tools/rcv';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearRegistroSesionesSii } from './registroSesionesSii';

export function createServer(): McpServer {
  const browser = new Browser();
  const credenciales = new ProveedorCredencialesRuntime();
  const registro = crearRegistroSesionesSii(credenciales, browser);

  const server = new McpServer({
    name: 'mcp-sii',
    version: '0.1.0',
  });

  registerMipymeTools(server, registro);
  registerDteTools(server, registro);
  registerBienesRaicesTools(server, registro);
  registerSesionTools(server, registro, credenciales);
  registerBheTools(server, registro);
  registerRentaTools(server, registro);
  registerRcvTools(server, registro);

  return server;
}
```

3b. Para cada uno de `mipyme.ts`, `dte.ts`, `bhe.ts`, `renta.ts`, `rcv.ts` y
`registerBienesRaicesTools` en `bienesRaices.ts`: cambiar la firma de
`registerXTools(server, scraperYaConstruido)` a
`registerXTools(server, registro: RegistroSesiones<SessionManager>)`, agregar
`rut: z.string().describe('RUT de la persona con sesión iniciada vía sii_iniciar_sesion')`
como primer campo del schema zod de cada tool del archivo, y envolver cada
handler con el patrón mostrado arriba (`conErroresDeSesion` +
`registro.ejecutar`), construyendo el scraper correspondiente al dominio
adentro del closure. Antes de tocar cada archivo, releer el archivo actual
completo para no perder ningún parámetro existente (`empresa_rut`, filtros
de fecha, etc.) — sólo se agrega `rut` y se envuelve el cuerpo, nada más
cambia de firma.

Confirmar en `src/env.ts` y en cada scraper (`src/scrapers/*.ts`) los
constructores exactos (`new SiiHttpClient(sesion)`, `new BheScraper(http,
sesion)`, etc.) antes de escribir el wiring — deben coincidir con lo que
`server.ts` arma hoy en las líneas 21-37 (ya leídas para este plan).

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run tests/tools/mipyme.test.ts`
Expected: PASS (2 tests)

Run también la suite completa para confirmar que no se rompió nada:
Run: `npx vitest run`
Expected: todos los tests existentes (incluyendo
`tests/registroSesionesSii.test.ts`, `tests/credencialesEnMemoria.test.ts`,
`tests/registroSesiones.test.ts`) siguen en PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/tools/mipyme.ts src/tools/dte.ts src/tools/bhe.ts src/tools/renta.ts src/tools/rcv.ts src/tools/bienesRaices.ts tests/tools/mipyme.test.ts
git commit -m "feat: cablear todas las tools al registro de sesiones por RUT"
```

---

### Task 5: Actualizar README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Documentar el nuevo flujo**

Agregar una sección (o actualizar la existente sobre uso) explicando que
antes de llamar cualquier tool hay que `sii_iniciar_sesion(rut, clave)`, que
`rut` es ahora un parámetro obligatorio en todas las tools de consulta, y
que `sii_cerrar_sesion(rut)` cierra y olvida la credencial de ese RUT. Quitar
o marcar como legado cualquier mención a `SII_RUT`/`SII_CLAVE` fijos por
proceso si el README los presenta como la única forma de autenticar.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: documentar sii_iniciar_sesion y el flujo multi-RUT"
```

---

## Self-review notes (ya aplicado en este documento)

- Cobertura del spec: identidad por persona (Task 1/3), sin auto-login
  (Task 3/4 vía `SESION_NO_INICIADA`), reautenticación idempotente (Task 3,
  delega en `authenticateOnly()` ya idempotente), `sii_cerrar_sesion` borra
  credencial (Task 3), normalización de RUT (Task 1). `SESION_EXPIRADA`
  queda con wrapper preparado (Task 2) pero sin emisor real todavía — no hay
  hoy una señal explícita de sesión-vencida-a-mitad-de-operación distinta de
  reautenticación transparente; si al implementar Task 4 aparece un caso
  real que la dispare, usarlo ahí.
- Task 4 es deliberadamente el único task grande: cablear 6 archivos con el
  mismo patrón no amerita partirlo en 6 tasks idénticos, pero si el
  implementador nota que un dominio (p. ej. BHE, que exige certificado) no
  encaja en el patrón genérico, debe pararse y reportarlo antes de forzarlo.
