# Adaptador REST — dominios restantes + absorber validar-clave (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminar de migrar los 5 dominios que quedaron fuera del PR #33 (bhe, renta, bienesRaices/persona, dte, mipyme) al patrón core+schema+ruta REST ya probado con RCV, y absorber `validar-clave` (PR #32) como `POST /v1/sesion/validar-clave` en el mismo adaptador, retirando `httpServer.ts`/`httpServerIndex.ts`.

**Architecture:** Mismo patrón que RCV (PR #33): cada operación se extrae de `src/tools/*.ts` a `src/core/*.ts` (funciones de dominio, tipadas contra `EjecutorSesion<T>`) + `src/core/schemas/*.ts` (schema zod compartido). `src/tools/*.ts` pasa a ser un adaptador fino sobre el core; `src/rest/rutas/*.ts` es el otro. El wrapper `{content}` para MCP, hoy duplicado en `tools/rcv.ts`, se extrae a `erroresSesion.ts` como `envolverParaMcp` (ya lo usa un segundo dominio, así que corresponde sacarlo — mismo criterio que ya se aplicó con `clasificarErrorCredenciales`).

**Tech Stack:** TypeScript, zod, Jest — mismo stack que el resto del repo, sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-08-19-adaptador-rest-neon-design.md`

## Global Constraints

- La clave tributaria nunca se persiste; pass-through por request, igual que RCV.
- `SII_EMPRESA_RUT` (env var de proceso) se elimina como fallback en las rutas REST de mipyme — ya decidido en la spec, arriesgaba filtrar la empresa de otro tenant. Las tools MCP siguen usando el fallback tal cual (no se toca ese comportamiento en MCP).
- `sii_mipyme_emitir_dte` con `confirmar=true` (firma real) queda bloqueado en la ruta REST — responde `400 CONFIRMAR_NO_SOPORTADO` explícito, no lo ignora en silencio. Bloqueado hasta resolver el pendiente de certificado digital (memoria del proyecto).
- Todas las rutas nuevas bajo `/v1`, mismo contrato de errores que RCV (`{ok}` en 200 para negocio, status HTTP para transporte).
- Cada task de dominio sigue el mismo ciclo TDD: test del core → implementar core → test de la ruta REST → implementar ruta → montar en `restServer.ts` → correr toda la suite → commit.
- Antes de cada `npm test` que toque infra (ninguna task de dominio la toca — sólo Task 8, validar-clave, y Task 9, limpieza), no hace falta Postgres; las tasks 1-7 son puro TypeScript sin DB.

---

## File Structure

- **Modifica** `src/erroresSesion.ts`: agrega `envolverParaMcp`.
- **Por cada dominio** (bhe, renta, bienesRaices, dte, mipyme):
  - Crea `src/core/schemas/<dominio>.ts`
  - Crea `src/core/<dominio>.ts`
  - Modifica `src/tools/<dominio>.ts`
  - Crea `src/rest/rutas/<dominio>.ts`
- **Modifica** `src/session.ts`: agrega un getter para exponer el `Browser` de una sesión (lo necesita `bienesRaices`, el único dominio cuyo scraper toma `Browser` en vez de `SiiHttpClient`).
- **Modifica** `src/restServer.ts`: monta las rutas de los 5 dominios + `sesion` (validar-clave).
- **Crea** `src/rest/rutas/sesion.ts`: `POST /v1/sesion/validar-clave`, migrado de `httpServer.ts`.
- **Elimina** `src/httpServer.ts`, `src/httpServerIndex.ts`, `src/apiKey.ts` (su única razón de ser —la comparación de API key fija— ya no aplica: el REST usa API keys por tenant en Neon).
- **Modifica** `package.json`: quita `start:validar-clave`.
- **Elimina** (al final, cuando ya no tenga callers) `crearConScraper` de `src/erroresSesion.ts`.
- **Tests:** `tests/core/*.test.ts` y `tests/rest/rutas/*.test.ts` nuevos por dominio; los `tests/tools/*.test.ts` existentes se actualizan mínimamente (mismos casos, mismo contrato externo) donde el refactor lo exija.

---

### Task 1: Extraer `envolverParaMcp` y `ejecutorPassThroughDe` a módulos compartidos

**Files:**
- Modify: `src/erroresSesion.ts`
- Create: `src/rest/ejecutorPassThrough.ts`
- Modify: `src/tools/rcv.ts`, `src/rest/rutas/rcv.ts`
- Test: `tests/erroresSesion.test.ts`, `tests/rest/ejecutorPassThrough.test.ts`

**Interfaces:**
- Produces: `envolverParaMcp<R>(fn: () => Promise<R>): Promise<{ content: [{ type: 'text'; text: string }] }>` (en `erroresSesion.ts`) y `ejecutorPassThroughDe<T>(registro: RegistroSesiones<T>, credenciales: ProveedorCredencialesRuntime, rut: string, clave: string): EjecutorSesion<T>` (en `src/rest/ejecutorPassThrough.ts`). Las usan `tools/rcv.ts`/`rest/rutas/rcv.ts` (ya, se actualizan acá) y las 6 rutas REST de las tasks siguientes (5 dominios + sesión).

**Nota:** en el PR #33, `rest/rutas/rcv.ts` ya define una función local `ejecutorPassThroughDe` con exactamente esta forma. Esta task la saca de ahí a un módulo propio — es el mismo criterio de "extraer al aparecer el segundo consumidor" que ya se aplicó con `clasificarErrorCredenciales`, adelantado acá porque en este plan se sabe de entrada que va a haber 6 consumidores más, no sólo uno.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `tests/erroresSesion.test.ts`:

```typescript
import { envolverParaMcp } from '../src/erroresSesion';

describe('envolverParaMcp', () => {
  it('envuelve el resultado exitoso en {content}', async () => {
    const resultado = await envolverParaMcp(() => Promise.resolve({ filas: [1, 2] }));
    expect(JSON.parse(resultado.content[0].text)).toEqual({ filas: [1, 2] });
  });

  it('traduce SesionNoIniciada a {ok:false, error:SESION_NO_INICIADA}', async () => {
    const resultado = await envolverParaMcp(() =>
      Promise.reject(new Error('No hay sesión iniciada para el RUT 1. Llamá sii_iniciar_sesion primero.'))
    );
    expect(JSON.parse(resultado.content[0].text)).toEqual({ ok: false, error: 'SESION_NO_INICIADA' });
  });

  it('deja pasar cualquier otro error sin traducirlo', async () => {
    await expect(envolverParaMcp(() => Promise.reject(new Error('otro fallo')))).rejects.toThrow('otro fallo');
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/erroresSesion.test.ts -t "envolverParaMcp"`
Expected: FAIL — no existe todavía.

- [ ] **Step 3: Implementar**

Agregar a `src/erroresSesion.ts` (después de `clasificarErrorCredenciales`, antes de `crearConScraper`):

```typescript
// Envuelve el resultado de una función de core (src/core/*.ts) en el contrato
// {content} que exige el SDK de MCP, traduciendo SesionNoIniciada a
// {ok:false, error:'SESION_NO_INICIADA'} en vez de dejarla escapar. Extraído
// de tools/rcv.ts (PR #33) porque un segundo dominio ya la necesita — misma
// razón por la que se extrajo clasificarErrorCredenciales.
export async function envolverParaMcp<R>(fn: () => Promise<R>): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const resultado = await conErroresDeSesion(fn).catch(e => {
    if (e instanceof SesionNoIniciada) return { __error: 'SESION_NO_INICIADA' as const };
    throw e;
  });
  if (resultado && typeof resultado === 'object' && '__error' in resultado) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: resultado.__error }) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }] };
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npx jest tests/erroresSesion.test.ts`
Expected: PASS

- [ ] **Step 5: Actualizar `tools/rcv.ts` para usar la versión compartida**

En `src/tools/rcv.ts`, eliminar la función local `envolverParaMcp` (queda idéntica a la nueva) y cambiar el import:

```typescript
import { envolverParaMcp } from '../erroresSesion';
```

- [ ] **Step 6: Escribir el test de `ejecutorPassThroughDe` que falla**

Crear `tests/rest/ejecutorPassThrough.test.ts`:

```typescript
import { ejecutorPassThroughDe } from '../../src/rest/ejecutorPassThrough';
import { RegistroSesiones } from '../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../src/credencialesRuntime';

describe('ejecutorPassThroughDe', () => {
  it('guarda la credencial, corre fn, y la borra — vía ejecutarPassThrough del registro', async () => {
    const llamadas: any[] = [];
    const registro = {
      ejecutarPassThrough: (rut: string, preparar: () => void, finalizar: () => void, fn: any) => {
        llamadas.push({ rut, preparar, finalizar });
        return Promise.resolve('fn').then(async () => { preparar(); const r = await fn({}); finalizar(); return r; });
      },
    } as unknown as RegistroSesiones<any>;
    const credenciales = new ProveedorCredencialesRuntime();

    const ejecutor = ejecutorPassThroughDe(registro, credenciales, '11.111.111-1', 'secreta');
    const resultado = await ejecutor.ejecutar('11.111.111-1', async () => 'ok');

    expect(resultado).toBe('ok');
    expect(llamadas).toHaveLength(1);
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow(); // borrada al final
  });
});
```

- [ ] **Step 7: Correr el test y confirmar que falla**

Run: `npx jest tests/rest/ejecutorPassThrough.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 8: Implementar**

Crear `src/rest/ejecutorPassThrough.ts`:

```typescript
import { RegistroSesiones, EjecutorSesion } from '../registroSesiones';
import { ProveedorCredencialesRuntime } from '../credencialesRuntime';

// Arma un EjecutorSesion de un solo uso para UN request REST: guardar la
// credencial, crear la sesión, correr fn y borrar la credencial corren como
// una sola unidad atómica encolada por RUT (ver
// RegistroSesiones.ejecutarPassThrough, PR #33). Sin esto, dos requests
// concurrentes al mismo RUT con clave DISTINTA podían pisarse la credencial
// entre sí. La misma función la usa cada dominio del adaptador REST — se
// extrae acá en vez de dejarla copiada 6 veces (una por dominio).
export function ejecutorPassThroughDe<T>(
  registro: RegistroSesiones<T>,
  credenciales: ProveedorCredencialesRuntime,
  rut: string,
  clave: string
): EjecutorSesion<T> {
  return {
    ejecutar: (rutInterno, fn) =>
      registro.ejecutarPassThrough(
        rutInterno,
        () => credenciales.guardar(rut, clave),
        () => credenciales.borrar(rut),
        fn
      ),
  };
}
```

- [ ] **Step 9: Correr el test y confirmar que pasa**

Run: `npx jest tests/rest/ejecutorPassThrough.test.ts`
Expected: PASS

- [ ] **Step 10: Actualizar `src/rest/rutas/rcv.ts` para usar la versión compartida**

Eliminar la función local `ejecutorPassThroughDe` de `src/rest/rutas/rcv.ts` (queda idéntica a la nueva) y agregar el import:

```typescript
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
```

(El resto del archivo no cambia — la función se llama exactamente igual.)

- [ ] **Step 11: Correr la suite completa**

Run: `npm test`
Expected: PASS — sin Postgres, esta parte no toca infra.

- [ ] **Step 12: Commit**

```bash
git add src/erroresSesion.ts src/tools/rcv.ts src/rest/ejecutorPassThrough.ts src/rest/rutas/rcv.ts tests/erroresSesion.test.ts tests/rest/ejecutorPassThrough.test.ts
git commit -m "refactor: extraer envolverParaMcp y ejecutorPassThroughDe a módulos compartidos, antes de migrar los 5 dominios restantes"
```

---

### Task 2: Dominio BHE

**Files:**
- Create: `src/core/schemas/bhe.ts`
- Create: `src/core/bhe.ts`
- Modify: `src/tools/bhe.ts`
- Create: `src/rest/rutas/bhe.ts`
- Test: `tests/core/bhe.test.ts`, `tests/rest/rutas/bhe.test.ts`

**Interfaces:**
- Produces: `core.resumen(ejecutor, rut, anio)`, `core.listEmitidas(ejecutor, rut, anio, mes)`, `core.listRecibidas(ejecutor, rut, anio, mes)`; `schemaResumen`, `schemaMes`; `registrarRutasBhe(rutas, registro, credenciales)`.

- [ ] **Step 1: Escribir el test del core que falla**

Crear `tests/core/bhe.test.ts`:

```typescript
import { resumen, listEmitidas, listRecibidas } from '../../src/core/bhe';
import { BheScraper } from '../../src/scrapers/bhe';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/bhe');
const MockScraper = BheScraper as jest.MockedClass<typeof BheScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/bhe', () => {
  afterEach(() => jest.clearAllMocks());

  it('resumen llama informeAnual con el año', async () => {
    (MockScraper.prototype.informeAnual as jest.Mock).mockResolvedValue({ meses: [] });
    const resultado = await resumen(registroQueEjecuta(), '11.111.111-1', 2026);
    expect(MockScraper.prototype.informeAnual).toHaveBeenCalledWith(2026);
    expect(resultado).toEqual({ meses: [] });
  });

  it('listEmitidas llama informeMensual sin el flag de recibidas', async () => {
    (MockScraper.prototype.informeMensual as jest.Mock).mockResolvedValue([]);
    await listEmitidas(registroQueEjecuta(), '11.111.111-1', 2026, 7);
    expect(MockScraper.prototype.informeMensual).toHaveBeenCalledWith(2026, 7, false);
  });

  it('listRecibidas llama informeMensual con recibidas=true', async () => {
    (MockScraper.prototype.informeMensual as jest.Mock).mockResolvedValue([]);
    await listRecibidas(registroQueEjecuta(), '11.111.111-1', 2026, 7);
    expect(MockScraper.prototype.informeMensual).toHaveBeenCalledWith(2026, 7, true);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/core/bhe.test.ts`
Expected: FAIL — `src/core/bhe.ts` no existe.

- [ ] **Step 3: Implementar el schema**

Crear `src/core/schemas/bhe.ts`:

```typescript
import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export const schemaResumen = {
  rut: z.string().describe(RUT_DESC),
  anio: z.number().int().min(2000).max(2100).describe('Año tributario a consultar'),
};

export const schemaMes = {
  rut: z.string().describe(RUT_DESC),
  anio: z.number().int().min(2000).max(2100).describe('Año a consultar'),
  mes: z.number().int().min(1).max(12).describe('Mes a consultar (1-12)'),
};
```

- [ ] **Step 4: Implementar el core**

Crear `src/core/bhe.ts`:

```typescript
import { BheScraper, InformeAnualBhe, BoletaBhe } from '../scrapers/bhe';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function resumen(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number
): Promise<InformeAnualBhe> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BheScraper(new SiiHttpClient(sesion), sesion);
    return scraper.informeAnual(anio);
  });
}

export async function listEmitidas(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number,
  mes: number
): Promise<BoletaBhe[]> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BheScraper(new SiiHttpClient(sesion), sesion);
    return scraper.informeMensual(anio, mes, false);
  });
}

export async function listRecibidas(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number,
  mes: number
): Promise<BoletaBhe[]> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BheScraper(new SiiHttpClient(sesion), sesion);
    return scraper.informeMensual(anio, mes, true);
  });
}
```

- [ ] **Step 5: Correr el test del core y confirmar que pasa**

Run: `npx jest tests/core/bhe.test.ts`
Expected: PASS

- [ ] **Step 6: Actualizar `src/tools/bhe.ts`**

Reemplazar el contenido completo:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/bhe';
import { schemaResumen, schemaMes } from '../core/schemas/bhe';

export function registerBheTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_bhe_resumen',
    'Resumen anual de las boletas de honorarios electrónicas emitidas por el RUT persona autenticado en el SII. Devuelve, por cada mes con actividad, el honorario bruto, la retención de terceros y del contribuyente, el rango de folios y cuántas boletas están vigentes o anuladas. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaResumen,
    async ({ rut, anio }) => envolverParaMcp(() => core.resumen(registro, rut, anio))
  );

  server.tool(
    'sii_bhe_list_emitidas',
    'Lista boleta por boleta las boletas de honorarios electrónicas emitidas por el RUT persona autenticado en un mes: folio, fecha, receptor de la boleta (en contraparteRut/contraparteNombre, con contraparteRol="receptor"), honorario bruto, retención del emisor y del receptor, total líquido y si está anulada. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaMes,
    async ({ rut, anio, mes }) => envolverParaMcp(() => core.listEmitidas(registro, rut, anio, mes))
  );

  server.tool(
    'sii_bhe_list_recibidas',
    'Lista las boletas de honorarios electrónicas recibidas por el RUT persona autenticado en un mes: folio, fecha, emisor de la boleta (en contraparteRut/contraparteNombre, con contraparteRol="emisor"), honorario bruto, retención del receptor, total líquido y si está anulada. El SII no informa la retención del emisor en las recibidas, así que retencionEmisor viene en null. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaMes,
    async ({ rut, anio, mes }) => envolverParaMcp(() => core.listRecibidas(registro, rut, anio, mes))
  );
}
```

- [ ] **Step 7: Correr los tests existentes de la tool y la suite completa**

Run: `npx jest tests/tools/bhe.test.ts && npm test`
Expected: PASS — el contrato externo del MCP (nombres de tool, schemas, `{ok:false,error:'SESION_NO_INICIADA'}`) no cambió.

- [ ] **Step 8: Escribir el test de la ruta REST que falla**

Crear `tests/rest/rutas/bhe.test.ts`:

```typescript
import { registrarRutasBhe } from '../../../src/rest/rutas/bhe';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/bhe';

jest.mock('../../../src/core/bhe');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasBhe(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasBhe', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 3 rutas bajo /v1/bhe', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/bhe/resumen', 'POST /v1/bhe/list-emitidas', 'POST /v1/bhe/list-recibidas',
    ]);
  });

  it('resumen: body válido llama al core y devuelve {ok:true, ...datos}', async () => {
    (core.resumen as jest.Mock).mockResolvedValue({ meses: [] });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({ rut: '11.111.111-1', clave: 'x', anio: 2026 });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, meses: [] } });
  });

  it('resumen: body inválido devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/bhe/resumen')!({ rut: '1', clave: 'x', anio: 1899 });
    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('list-emitidas: pasa anio y mes al core', async () => {
    (core.listEmitidas as jest.Mock).mockResolvedValue([]);
    const rutas = armarRouter();
    await rutas.get('POST /v1/bhe/list-emitidas')!({ rut: '11.111.111-1', clave: 'x', anio: 2026, mes: 7 });
    expect(core.listEmitidas).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', 2026, 7);
  });
});
```

- [ ] **Step 9: Correr el test y confirmar que falla**

Run: `npx jest tests/rest/rutas/bhe.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 10: Implementar la ruta REST**

Crear `src/rest/rutas/bhe.ts`:

```typescript
import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/bhe';
import { schemaResumen, schemaMes } from '../../core/schemas/bhe';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler } from './rcv';

const zodResumen = z.object(schemaResumen).extend({ clave: z.string().min(1) });
const zodMes = z.object(schemaMes).extend({ clave: z.string().min(1) });

async function ejecutar<R>(fn: () => Promise<R>) {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasBhe(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/bhe/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.resumen(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/bhe/list-emitidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio, mes } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listEmitidas(ejecutor, rut, anio, mes));
  });

  rutas.set('POST /v1/bhe/list-recibidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio, mes } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listRecibidas(ejecutor, rut, anio, mes));
  });
}
```

**Nota:** `RutaHandler` se importa desde `./rcv` (definido ahí en el PR #33) — no se duplica el tipo. Si en una task posterior conviene mudarlo a un módulo común (`src/rest/tipos.ts`), hacerlo ahí y actualizar todos los imports de una vez, no antes.

- [ ] **Step 11: Correr el test de la ruta y confirmar que pasa**

Run: `npx jest tests/rest/rutas/bhe.test.ts`
Expected: PASS

- [ ] **Step 12: Montar en `restServer.ts`**

En `src/restServer.ts`, agregar el import y la llamada:

```typescript
import { registrarRutasBhe } from './rest/rutas/bhe';
```

Y dentro de `crearRestServer`, después de `registrarRutasRcv(rutas, registro, credenciales);`:

```typescript
  registrarRutasBhe(rutas, registro, credenciales);
```

- [ ] **Step 13: Correr toda la suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add src/core/schemas/bhe.ts src/core/bhe.ts src/tools/bhe.ts src/rest/rutas/bhe.ts src/restServer.ts tests/core/bhe.test.ts tests/rest/rutas/bhe.test.ts
git commit -m "feat: migrar dominio BHE a core+schema, agregar rutas REST /v1/bhe/*"
```

---

### Task 3: Dominio Renta

Mismo patrón que Task 2. Operaciones: `estadoDeclaracion(anio)`, `f22Completo(anio, folio?)`.

**Files:**
- Create: `src/core/schemas/renta.ts`, `src/core/renta.ts`, `src/rest/rutas/renta.ts`
- Modify: `src/tools/renta.ts`, `src/restServer.ts`
- Test: `tests/core/renta.test.ts`, `tests/rest/rutas/renta.test.ts`

- [ ] **Step 1: Test del core**

Crear `tests/core/renta.test.ts`:

```typescript
import { estadoDeclaracion, f22Completo } from '../../src/core/renta';
import { RentaScraper } from '../../src/scrapers/renta';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/renta');
const MockScraper = RentaScraper as jest.MockedClass<typeof RentaScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/renta', () => {
  afterEach(() => jest.clearAllMocks());

  it('estadoDeclaracion pasa el año', async () => {
    (MockScraper.prototype.estadoDeclaracion as jest.Mock).mockResolvedValue({ declaraciones: [] });
    const resultado = await estadoDeclaracion(registroQueEjecuta(), '11.111.111-1', 2026);
    expect(MockScraper.prototype.estadoDeclaracion).toHaveBeenCalledWith(2026);
    expect(resultado).toEqual({ declaraciones: [] });
  });

  it('f22Completo pasa año y folio (opcional)', async () => {
    (MockScraper.prototype.f22Completo as jest.Mock).mockResolvedValue({ lineas: [] });
    await f22Completo(registroQueEjecuta(), '11.111.111-1', 2026, 123);
    expect(MockScraper.prototype.f22Completo).toHaveBeenCalledWith(2026, 123);
  });

  it('f22Completo sin folio pasa undefined', async () => {
    (MockScraper.prototype.f22Completo as jest.Mock).mockResolvedValue({ lineas: [] });
    await f22Completo(registroQueEjecuta(), '11.111.111-1', 2026, undefined);
    expect(MockScraper.prototype.f22Completo).toHaveBeenCalledWith(2026, undefined);
  });
});
```

- [ ] **Step 2: Correr y confirmar que falla.** Run: `npx jest tests/core/renta.test.ts` — FAIL.

- [ ] **Step 3: Schema**

Crear `src/core/schemas/renta.ts`:

```typescript
import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export const anioSchema = z.number().int().min(2000).max(2100)
  .describe('Año tributario a consultar (el año en que se declaró, no el año de los ingresos)');

export const schemaEstadoDeclaracion = {
  rut: z.string().describe(RUT_DESC),
  anio: anioSchema,
};

export const schemaF22 = {
  rut: z.string().describe(RUT_DESC),
  anio: anioSchema,
  folio: z.number().int().positive().optional()
    .describe('Folio de la declaración. Si se omite, se usa el de la declaración vigente del año.'),
};
```

- [ ] **Step 4: Core**

Crear `src/core/renta.ts`:

```typescript
import { RentaScraper, EstadoDeclaracionRenta, F22Completo } from '../scrapers/renta';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function estadoDeclaracion(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number
): Promise<EstadoDeclaracionRenta> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new RentaScraper(new SiiHttpClient(sesion), sesion);
    return scraper.estadoDeclaracion(anio);
  });
}

export async function f22Completo(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  anio: number,
  folio?: number
): Promise<F22Completo> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new RentaScraper(new SiiHttpClient(sesion), sesion);
    return scraper.f22Completo(anio, folio);
  });
}
```

- [ ] **Step 5: Correr el test del core.** Run: `npx jest tests/core/renta.test.ts` — PASS.

- [ ] **Step 6: Actualizar `src/tools/renta.ts`**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/renta';
import { schemaEstadoDeclaracion, schemaF22 } from '../core/schemas/renta';

export function registerRentaTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_renta_estado_declaracion',
    'Estado de la declaración de renta (Formulario 22) del RUT persona autenticado para un año tributario. ' +
    'Devuelve las declaraciones del año (folio, si es la vigente, código de estado, domicilio, fecha de ' +
    'vencimiento y remanente solicitado/devuelto) junto con las glosas: el texto del SII que explica el ' +
    'estado —si hubo devolución y por cuánto, o qué inconsistencia se detectó—, que es lo más útil de la ' +
    'respuesta. Si el año no tiene declaración, responde sinDatos=true con las listas vacías: es un vacío ' +
    'legítimo, no un error. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaEstadoDeclaracion,
    async ({ rut, anio }) => envolverParaMcp(() => core.estadoDeclaracion(registro, rut, anio))
  );

  server.tool(
    'sii_renta_get_f22',
    'Formulario 22 completo de un año tributario del RUT persona autenticado: la lista de todos los códigos ' +
    'del formulario con su valor y su glosa. Si se omite el folio, se resuelve solo consultando la ' +
    'declaración vigente del año (una consulta extra al SII); si ese año no tiene una declaración vigente, ' +
    'falla pidiendo el folio explícito en vez de devolver un formulario vacío. ' +
    'No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaF22,
    async ({ rut, anio, folio }) => envolverParaMcp(() => core.f22Completo(registro, rut, anio, folio))
  );
}
```

- [ ] **Step 7: Correr tests existentes + suite.** Run: `npx jest tests/tools/renta.test.ts && npm test` — PASS.

- [ ] **Step 8: Test de la ruta REST**

Crear `tests/rest/rutas/renta.test.ts`:

```typescript
import { registrarRutasRenta } from '../../../src/rest/rutas/renta';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/renta';

jest.mock('../../../src/core/renta');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasRenta(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasRenta', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 2 rutas bajo /v1/renta', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual(['POST /v1/renta/estado-declaracion', 'POST /v1/renta/f22']);
  });

  it('estado-declaracion: body válido llama al core', async () => {
    (core.estadoDeclaracion as jest.Mock).mockResolvedValue({ declaraciones: [] });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/renta/estado-declaracion')!({ rut: '11.111.111-1', clave: 'x', anio: 2026 });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, declaraciones: [] } });
  });

  it('f22: pasa folio opcional', async () => {
    (core.f22Completo as jest.Mock).mockResolvedValue({ lineas: [] });
    const rutas = armarRouter();
    await rutas.get('POST /v1/renta/f22')!({ rut: '11.111.111-1', clave: 'x', anio: 2026, folio: 5 });
    expect(core.f22Completo).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', 2026, 5);
  });
});
```

- [ ] **Step 9: Correr y confirmar que falla.** Run: `npx jest tests/rest/rutas/renta.test.ts` — FAIL.

- [ ] **Step 10: Implementar la ruta**

Crear `src/rest/rutas/renta.ts`:

```typescript
import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/renta';
import { schemaEstadoDeclaracion, schemaF22 } from '../../core/schemas/renta';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler } from './rcv';

const zodEstadoDeclaracion = z.object(schemaEstadoDeclaracion).extend({ clave: z.string().min(1) });
const zodF22 = z.object(schemaF22).extend({ clave: z.string().min(1) });

async function ejecutar<R>(fn: () => Promise<R>) {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasRenta(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/renta/estado-declaracion', async body => {
    const parseo = zodEstadoDeclaracion.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.estadoDeclaracion(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/renta/f22', async body => {
    const parseo = zodF22.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, anio, folio } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.f22Completo(ejecutor, rut, anio, folio));
  });
}
```

- [ ] **Step 11: Correr y confirmar que pasa.** Run: `npx jest tests/rest/rutas/renta.test.ts` — PASS.

- [ ] **Step 12: Montar en `restServer.ts`**

Agregar `import { registrarRutasRenta } from './rest/rutas/renta';` y, en `crearRestServer`, `registrarRutasRenta(rutas, registro, credenciales);`.

- [ ] **Step 13: Suite completa.** Run: `npm test` — PASS.

- [ ] **Step 14: Commit**

```bash
git add src/core/schemas/renta.ts src/core/renta.ts src/tools/renta.ts src/rest/rutas/renta.ts src/restServer.ts tests/core/renta.test.ts tests/rest/rutas/renta.test.ts
git commit -m "feat: migrar dominio Renta a core+schema, agregar rutas REST /v1/renta/*"
```

---

### Task 4: Dominio Bienes Raíces (persona)

Único dominio cuyo scraper toma `Browser` en vez de `SiiHttpClient` — necesita exponer el `Browser` de la sesión.

**Files:**
- Modify: `src/session.ts` (getter nuevo)
- Create: `src/core/schemas/bienesRaices.ts`, `src/core/bienesRaices.ts`, `src/rest/rutas/bienesRaices.ts`
- Modify: `src/tools/bienesRaices.ts`, `src/restServer.ts`
- Test: `tests/session.test.ts` (agrega caso), `tests/core/bienesRaices.test.ts`, `tests/rest/rutas/bienesRaices.test.ts`

**Interfaces:**
- Produces: `SessionManager.obtenerBrowser(): Browser`; `core.listBienesRaices(ejecutor, rut)`; `registrarRutasBienesRaices(rutas, registro, credenciales)`.

- [ ] **Step 1: Escribir el test del getter que falla**

Agregar a `tests/session.test.ts`:

```typescript
it('obtenerBrowser() devuelve el Browser con el que se construyó la sesión', () => {
  const browser = new Browser();
  const sesion = new SessionManager({ rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'x' }, browser);
  expect(sesion.obtenerBrowser()).toBe(browser);
});
```

(Ajustar los imports del archivo si `Browser`/`AuthStrategy` no están importados ya — revisar el resto de `tests/session.test.ts` para el patrón exacto de construcción de `SessionManager` que ya usan otros tests del archivo.)

- [ ] **Step 2: Correr y confirmar que falla.** Run: `npx jest tests/session.test.ts -t "obtenerBrowser"` — FAIL.

- [ ] **Step 3: Implementar el getter**

En `src/session.ts`, dentro de la clase `SessionManager`, agregar (cerca del constructor):

```typescript
  // Expone el Browser de esta sesión para scrapers que lo necesitan crudo
  // (BienesRaicesScraper lee el DOM directo, a diferencia del resto que habla
  // HTTP vía SiiHttpClient). El mismo Browser que ya autenticó esta sesión —
  // no uno nuevo — porque el estado autenticado vive en el contexto de
  // agent-browser que ese Browser referencia (--session <rut>).
  obtenerBrowser(): Browser {
    return this.browser;
  }
```

- [ ] **Step 4: Correr el test y confirmar que pasa.** Run: `npx jest tests/session.test.ts -t "obtenerBrowser"` — PASS.

- [ ] **Step 5: Test del core**

Crear `tests/core/bienesRaices.test.ts`:

```typescript
import { listBienesRaices } from '../../src/core/bienesRaices';
import { BienesRaicesScraper } from '../../src/scrapers/bienesRaices';
import { RegistroSesiones } from '../../src/registroSesiones';
import { Browser } from '../../src/browser';

jest.mock('../../src/scrapers/bienesRaices');
const MockScraper = BienesRaicesScraper as jest.MockedClass<typeof BienesRaicesScraper>;

describe('core/bienesRaices', () => {
  afterEach(() => jest.clearAllMocks());

  it('arma el scraper con el Browser de la sesión y llama listBienesRaices', async () => {
    (MockScraper.prototype.listBienesRaices as jest.Mock).mockResolvedValue({ propiedades: [] });
    const browser = new Browser();
    const registro = {
      ejecutar: (_rut: string, fn: any) => fn({ obtenerBrowser: () => browser }),
    } as unknown as RegistroSesiones<any>;

    const resultado = await listBienesRaices(registro, '11.111.111-1');

    expect(resultado).toEqual({ propiedades: [] });
  });
});
```

- [ ] **Step 6: Correr y confirmar que falla.** Run: `npx jest tests/core/bienesRaices.test.ts` — FAIL.

- [ ] **Step 7: Schema**

Crear `src/core/schemas/bienesRaices.ts`:

```typescript
import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

export const schemaListBienesRaices = {
  rut: z.string().describe(RUT_DESC),
};
```

- [ ] **Step 8: Core**

Crear `src/core/bienesRaices.ts`:

```typescript
import { BienesRaicesScraper, BienesRaicesResult } from '../scrapers/bienesRaices';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function listBienesRaices(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<BienesRaicesResult> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new BienesRaicesScraper(sesion.obtenerBrowser(), sesion);
    return scraper.listBienesRaices();
  });
}
```

- [ ] **Step 9: Correr el test del core.** Run: `npx jest tests/core/bienesRaices.test.ts` — PASS.

- [ ] **Step 10: Actualizar `src/tools/bienesRaices.ts`**

Este archivo tiene DOS exports: `registerSesionTools` (sii_iniciar_sesion/sii_cerrar_sesion — **no se toca en esta task**, se absorbe en la Task 8) y `registerBienesRaicesTools` (el dominio real). Reemplazar sólo la segunda función:

```typescript
import * as core from '../core/bienesRaices';
import { schemaListBienesRaices } from '../core/schemas/bienesRaices';
import { envolverParaMcp } from '../erroresSesion';

// ... (registerSesionTools queda exactamente igual, sin tocar)

export function registerBienesRaicesTools(
  server: McpServer,
  registro: RegistroSesiones<SessionManager>
): void {
  server.tool(
    'sii_persona_list_bienes_raices',
    'Lista los bienes raíces (propiedades) del RUT persona autenticado en el SII, con comuna, ROL, dirección, destino, datos de inscripción, porcentaje de derechos y avalúo fiscal. Incluye un resumen con total de propiedades, solicitudes, notificaciones, afectación a sobretasa y beneficio de adulto mayor. No requiere SII_EMPRESA_RUT: cuelga de la persona, no de la empresa.',
    schemaListBienesRaices,
    async ({ rut }) => envolverParaMcp(() => core.listBienesRaices(registro, rut))
  );
}
```

**Importante:** `registerBienesRaicesTools` ya NO recibe `browser` como parámetro (el core lo obtiene de la sesión vía `obtenerBrowser()`) — actualizar el caller en `src/server.ts`: cambiar `registerBienesRaicesTools(server, registro, browser)` por `registerBienesRaicesTools(server, registro)`. El import de `Browser` en `tools/bienesRaices.ts` deja de usarse para esta función — puede seguir importado si `registerSesionTools` no lo necesita tampoco (no lo necesita: revisar y quitar el import de `Browser` del archivo si queda sin uso).

- [ ] **Step 11: Correr tests existentes + suite**

Run: `npx jest tests/tools/bienesRaices.test.ts && npm test`
Expected: puede que `tests/tools/bienesRaices.test.ts` falle si construye el mock de sesión sin `obtenerBrowser` — si falla, agregar `obtenerBrowser: () => new Browser()` (o un mock) al objeto de sesión que ese test le pasa a `registro.ejecutar`. Corregir ahí, no en el core.

- [ ] **Step 12: Test de la ruta REST**

Crear `tests/rest/rutas/bienesRaices.test.ts`:

```typescript
import { registrarRutasBienesRaices } from '../../../src/rest/rutas/bienesRaices';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/bienesRaices';

jest.mock('../../../src/core/bienesRaices');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasBienesRaices(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasBienesRaices', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra POST /v1/persona/bienes-raices', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual(['POST /v1/persona/bienes-raices']);
  });

  it('body válido llama al core', async () => {
    (core.listBienesRaices as jest.Mock).mockResolvedValue({ propiedades: [] });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/persona/bienes-raices')!({ rut: '11.111.111-1', clave: 'x' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, propiedades: [] } });
  });
});
```

- [ ] **Step 13: Correr y confirmar que falla.** Run: `npx jest tests/rest/rutas/bienesRaices.test.ts` — FAIL.

- [ ] **Step 14: Implementar la ruta**

Crear `src/rest/rutas/bienesRaices.ts` (mismo patrón que `bhe.ts`/`renta.ts`, una sola ruta):

```typescript
import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/bienesRaices';
import { schemaListBienesRaices } from '../../core/schemas/bienesRaices';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler } from './rcv';

const zodListBienesRaices = z.object(schemaListBienesRaices).extend({ clave: z.string().min(1) });

async function ejecutar<R>(fn: () => Promise<R>) {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasBienesRaices(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/persona/bienes-raices', async body => {
    const parseo = zodListBienesRaices.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listBienesRaices(ejecutor, rut));
  });
}
```

- [ ] **Step 15: Correr y confirmar que pasa.** Run: `npx jest tests/rest/rutas/bienesRaices.test.ts` — PASS.

- [ ] **Step 16: Montar en `restServer.ts`**

Agregar `import { registrarRutasBienesRaices } from './rest/rutas/bienesRaices';` y, en `crearRestServer`, `registrarRutasBienesRaices(rutas, registro, credenciales);`.

- [ ] **Step 17: Suite completa.** Run: `npm test` — PASS.

- [ ] **Step 18: Commit**

```bash
git add src/session.ts src/core/schemas/bienesRaices.ts src/core/bienesRaices.ts src/tools/bienesRaices.ts src/server.ts src/rest/rutas/bienesRaices.ts src/restServer.ts tests/session.test.ts tests/core/bienesRaices.test.ts tests/rest/rutas/bienesRaices.test.ts
git commit -m "feat: migrar dominio Bienes Raíces a core+schema, agregar ruta REST /v1/persona/bienes-raices"
```

---

### Task 5: Dominio DTE (4 operaciones)

Mismo patrón, con una capa extra: `schemaListado`/`handler` son fábricas parametrizadas por `OperacionDte` en el archivo original — el core preserva esa forma.

**Files:**
- Create: `src/core/schemas/dte.ts`, `src/core/dte.ts`, `src/rest/rutas/dte.ts`
- Modify: `src/tools/dte.ts`, `src/restServer.ts`
- Test: `tests/core/dte.test.ts`, `tests/rest/rutas/dte.test.ts`

- [ ] **Step 1: Test del core**

Crear `tests/core/dte.test.ts`:

```typescript
import { listar, getDocumento } from '../../src/core/dte';
import { DteScraper } from '../../src/scrapers/dte';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/dte');
const MockScraper = DteScraper as jest.MockedClass<typeof DteScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/dte', () => {
  afterEach(() => jest.clearAllMocks());

  it('listar arma las opciones y pasa la operación', async () => {
    (MockScraper.prototype.listar as jest.Mock).mockResolvedValue({ filas: [] });
    await listar(registroQueEjecuta(), '11.111.111-1', '202607', 'EMITIDOS', {
      empresaRut: '22222222-2', tipoDocCodigo: 33, seccion: 'S1', contraparteRut: undefined, limit: undefined, incluirDetalle: false,
    });
    expect(MockScraper.prototype.listar).toHaveBeenCalledWith('202607', 'EMITIDOS', {
      empresaRut: '22222222-2', tipoDocCodigo: 33, seccion: 'S1', contraparteRut: undefined, limit: undefined, incluirDetalle: false,
    });
  });

  it('getDocumento pasa periodo, operacion, tipo_doc, folio y empresa', async () => {
    (MockScraper.prototype.getDocumento as jest.Mock).mockResolvedValue({ encontrado: true });
    await getDocumento(registroQueEjecuta(), '11.111.111-1', '202607', 'RECIBIDOS', 33, 100, '22222222-2');
    expect(MockScraper.prototype.getDocumento).toHaveBeenCalledWith('202607', 'RECIBIDOS', 33, 100, '22222222-2');
  });
});
```

- [ ] **Step 2: Correr y confirmar que falla.** Run: `npx jest tests/core/dte.test.ts` — FAIL.

- [ ] **Step 3: Schema**

Crear `src/core/schemas/dte.ts` — copiar tal cual (sin cambios de reglas) las constantes `ADVERTENCIA_*`, `EMPRESA_RUT_DESC`, `PERIODO_DESC` y las funciones `schemaListado`/`schemaDocumento` de `src/tools/dte.ts` líneas 13-86 y 91-121/171-179, exportándolas:

```typescript
import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

// [Copiar tal cual ADVERTENCIA_RCV, ADVERTENCIA_SECCION, ADVERTENCIA_PERIODO,
//  ADVERTENCIA_DETALLE, ADVERTENCIA_TOTALES, ADVERTENCIA_VACIO,
//  ADVERTENCIA_CONTRAPARTE, EMPRESA_RUT_DESC, PERIODO_DESC de
//  src/tools/dte.ts líneas 18-86 — mismo texto, exportadas con `export const`.]

export function schemaListado() {
  return {
    rut: z.string().describe(RUT_DESC),
    periodo: z.string().regex(/^\d{6}$/).describe(PERIODO_DESC),
    empresa_rut: z.string().optional().describe(EMPRESA_RUT_DESC),
    tipo_doc: z.number().int().positive().optional()
      .describe('Acota a un tipo de documento (33 factura electrónica, 34 exenta, 61 nota de crédito, ' +
        '46 factura de compra, 52 guía de despacho, 110 exportación). Si se omite, trae todos los ' +
        'tipos del período, con una consulta de detalle por fila del resumen.'),
    seccion: z.string().optional()
      .describe('Acota a una sección (S1, S2, S4, S5). Sirve para separar las dos filas de un mismo ' +
        'tipo de documento.'),
    contraparte_rut: z.string().optional()
      .describe('Filtra los documentos por RUT de la contraparte (22222222-2): el cliente en los ' +
        'emitidos, el proveedor en los recibidos. Es un filtro del lado del servidor MCP, sobre el ' +
        'detalle ya traído: NO reduce las consultas al SII. EXIGE incluir_detalle=true; con ' +
        'incluir_detalle=false la llamada FALLA en vez de devolver el resumen sin filtrar. Si no ' +
        'coincide ningún documento, la respuesta trae filtroContraparteSinCoincidencias=true, que no ' +
        'es lo mismo que un período sin movimientos.'),
    limit: z.number().int().min(1).max(500).optional()
      .describe('Máximo de documentos a devolver. Recorta la lista después de traerla, así que NO ' +
        'reduce las consultas al SII; sirve para no volcar cientos de documentos. EXIGE ' +
        'incluir_detalle=true: sin detalle la llamada FALLA en vez de ignorar el límite. Cuando ' +
        'recorta, documentosTruncados queda en true y totalDocumentos dice cuántos hay en realidad ' +
        '(los totales se calculan sobre todos, no sobre los devueltos).'),
    incluir_detalle: z.boolean().default(false)
      .describe('false por defecto: devuelve SÓLO el resumen por (tipo, sección) con UNA consulta. ' +
        'true trae además cada documento, y eso cuesta una consulta al SII POR CADA fila del resumen ' +
        '(siete en un período típico si no se acota con tipo_doc). El uso normal es resumen primero, ' +
        'y después el detalle del tipo que interese con tipo_doc: pedí incluir_detalle=true sólo ' +
        'cuando de verdad hagan falta los documentos.'),
  };
}

export const schemaDocumento = {
  rut: z.string().describe(RUT_DESC),
  periodo: z.string().regex(/^\d{6}$/).describe(PERIODO_DESC),
  tipo_doc: z.number().int().positive()
    .describe('Código del tipo de documento (33 factura electrónica, 34 exenta, 61 nota de crédito, ' +
      '46 factura de compra, 52 guía de despacho, 110 exportación)'),
  folio: z.number().int().positive().describe('Número de folio del documento'),
  empresa_rut: z.string().optional().describe(EMPRESA_RUT_DESC),
};
```

- [ ] **Step 4: Core**

Crear `src/core/dte.ts`:

```typescript
import { DteScraper, OperacionDte, ListadoDte, DocumentoDte } from '../scrapers/dte';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export interface OpcionesListadoDte {
  empresaRut?: string;
  tipoDocCodigo?: number;
  seccion?: string;
  contraparteRut?: string;
  limit?: number;
  incluirDetalle?: boolean;
}

export async function listar(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionDte,
  opciones: OpcionesListadoDte
): Promise<ListadoDte> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new DteScraper(new SiiHttpClient(sesion), sesion);
    return scraper.listar(periodo, operacion, opciones);
  });
}

export async function getDocumento(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionDte,
  tipoDocCodigo: number,
  folio: number,
  empresaRut?: string
): Promise<DocumentoDte> {
  return ejecutor.ejecutar(rut, async sesion => {
    const scraper = new DteScraper(new SiiHttpClient(sesion), sesion);
    return scraper.getDocumento(periodo, operacion, tipoDocCodigo, folio, empresaRut);
  });
}
```

- [ ] **Step 5: Correr el test del core.** Run: `npx jest tests/core/dte.test.ts` — PASS.

- [ ] **Step 6: Actualizar `src/tools/dte.ts`**

Reemplazar el contenido completo, conservando las descripciones de cada `server.tool(...)` tal cual (líneas 145-214 del archivo original), pero apoyándose en el schema/core extraídos:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OperacionDte } from '../scrapers/dte';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/dte';
import { schemaListado, schemaDocumento } from '../core/schemas/dte';

export function registerDteTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  const handler = (operacion: OperacionDte) =>
    async ({ rut, periodo, empresa_rut, tipo_doc, seccion, contraparte_rut, limit, incluir_detalle }: {
      rut: string; periodo: string; empresa_rut?: string; tipo_doc?: number;
      seccion?: string; contraparte_rut?: string; limit?: number; incluir_detalle: boolean;
    }) =>
      envolverParaMcp(() => core.listar(registro, rut, periodo, operacion, {
        empresaRut: empresa_rut, tipoDocCodigo: tipo_doc, seccion,
        contraparteRut: contraparte_rut, limit, incluirDetalle: incluir_detalle,
      }));

  server.tool(
    'sii_dte_list_documentos_emitidos',
    /* ... copiar tal cual la descripción de src/tools/dte.ts líneas 147-152 ... */
    schemaListado(),
    handler('EMITIDOS')
  );

  server.tool(
    'sii_dte_list_documentos_recibidos',
    /* ... copiar tal cual la descripción de src/tools/dte.ts líneas 159-166 ... */
    schemaListado(),
    handler('RECIBIDOS')
  );

  const handlerDocumento = (operacion: OperacionDte) =>
    async ({ rut, periodo, tipo_doc, folio, empresa_rut }: {
      rut: string; periodo: string; tipo_doc: number; folio: number; empresa_rut?: string;
    }) =>
      envolverParaMcp(() => core.getDocumento(registro, rut, periodo, operacion, tipo_doc, folio, empresa_rut));

  server.tool(
    'sii_dte_get_documento_emitido',
    /* ... copiar tal cual la descripción de src/tools/dte.ts líneas 195-199 ... */
    schemaDocumento,
    handlerDocumento('EMITIDOS')
  );

  server.tool(
    'sii_dte_get_documento_recibido',
    /* ... copiar tal cual la descripción de src/tools/dte.ts líneas 206-211 ... */
    schemaDocumento,
    handlerDocumento('RECIBIDOS')
  );
}
```

(Los `/* ... */` de arriba no son placeholders de lógica — son instrucción de copiar texto literal ya existente en el archivo que se está reemplazando; el string completo está en el archivo actual y no cambia una palabra.)

- [ ] **Step 7: Correr tests existentes + suite.** Run: `npx jest tests/tools/dte.test.ts && npm test` — PASS.

- [ ] **Step 8: Test de la ruta REST**

Crear `tests/rest/rutas/dte.test.ts`:

```typescript
import { registrarRutasDte } from '../../../src/rest/rutas/dte';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/dte';

jest.mock('../../../src/core/dte');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasDte(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasDte', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 4 rutas bajo /v1/dte', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/dte/list-documentos-emitidos',
      'POST /v1/dte/list-documentos-recibidos',
      'POST /v1/dte/get-documento-emitido',
      'POST /v1/dte/get-documento-recibido',
    ]);
  });

  it('list-documentos-emitidos: body válido llama a core.listar con EMITIDOS', async () => {
    (core.listar as jest.Mock).mockResolvedValue({ filas: [] });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/dte/list-documentos-emitidos')!({
      rut: '11.111.111-1', clave: 'x', periodo: '202607',
    });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, filas: [] } });
    expect(core.listar).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', '202607', 'EMITIDOS', expect.any(Object));
  });

  it('get-documento-recibido: body válido llama a core.getDocumento con RECIBIDOS', async () => {
    (core.getDocumento as jest.Mock).mockResolvedValue({ encontrado: false });
    const rutas = armarRouter();
    await rutas.get('POST /v1/dte/get-documento-recibido')!({
      rut: '11.111.111-1', clave: 'x', periodo: '202607', tipo_doc: 33, folio: 100,
    });
    expect(core.getDocumento).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', '202607', 'RECIBIDOS', 33, 100, undefined);
  });

  it('body inválido (falta periodo) devuelve 400', async () => {
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/dte/list-documentos-emitidos')!({ rut: '1', clave: 'x' });
    expect(respuesta.status).toBe(400);
  });
});
```

- [ ] **Step 9: Correr y confirmar que falla.** Run: `npx jest tests/rest/rutas/dte.test.ts` — FAIL.

- [ ] **Step 10: Implementar la ruta**

Crear `src/rest/rutas/dte.ts`:

```typescript
import { z } from 'zod';
import { OperacionDte } from '../../scrapers/dte';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/dte';
import { schemaListado, schemaDocumento } from '../../core/schemas/dte';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler } from './rcv';

const zodListado = z.object(schemaListado()).extend({ clave: z.string().min(1) });
const zodDocumento = z.object(schemaDocumento).extend({ clave: z.string().min(1) });

async function ejecutar<R>(fn: () => Promise<R>) {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasDte(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  const rutaListado = (nombre: string, operacion: OperacionDte) => {
    rutas.set(`POST /v1/dte/${nombre}`, async body => {
      const parseo = zodListado.safeParse(body);
      if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
      const { rut, clave, periodo, empresa_rut, tipo_doc, seccion, contraparte_rut, limit, incluir_detalle } = parseo.data;
      const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
      return ejecutar(() => core.listar(ejecutor, rut, periodo, operacion, {
        empresaRut: empresa_rut, tipoDocCodigo: tipo_doc, seccion,
        contraparteRut: contraparte_rut, limit, incluirDetalle: incluir_detalle,
      }));
    });
  };

  const rutaDocumento = (nombre: string, operacion: OperacionDte) => {
    rutas.set(`POST /v1/dte/${nombre}`, async body => {
      const parseo = zodDocumento.safeParse(body);
      if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
      const { rut, clave, periodo, tipo_doc, folio, empresa_rut } = parseo.data;
      const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
      return ejecutar(() => core.getDocumento(ejecutor, rut, periodo, operacion, tipo_doc, folio, empresa_rut));
    });
  };

  rutaListado('list-documentos-emitidos', 'EMITIDOS');
  rutaListado('list-documentos-recibidos', 'RECIBIDOS');
  rutaDocumento('get-documento-emitido', 'EMITIDOS');
  rutaDocumento('get-documento-recibido', 'RECIBIDOS');
}
```

- [ ] **Step 11: Correr y confirmar que pasa.** Run: `npx jest tests/rest/rutas/dte.test.ts` — PASS.

- [ ] **Step 12: Montar en `restServer.ts`**

Agregar `import { registrarRutasDte } from './rest/rutas/dte';` y, en `crearRestServer`, `registrarRutasDte(rutas, registro, credenciales);`.

- [ ] **Step 13: Suite completa.** Run: `npm test` — PASS.

- [ ] **Step 14: Commit**

```bash
git add src/core/schemas/dte.ts src/core/dte.ts src/tools/dte.ts src/rest/rutas/dte.ts src/restServer.ts tests/core/dte.test.ts tests/rest/rutas/dte.test.ts
git commit -m "feat: migrar dominio DTE a core+schema, agregar rutas REST /v1/dte/*"
```

---

### Task 6: Dominio Mipyme (sin firma real en REST)

`sii_mipyme_list_empresas` y `sii_mipyme_list_dte_emitidos` migran igual que los anteriores, **sin** el fallback a `SII_EMPRESA_RUT` en la ruta REST (la tool MCP lo conserva). `sii_mipyme_emitir_dte` se expone en REST **sólo como previsualización**: si `confirmar=true`, la ruta responde `400 CONFIRMAR_NO_SOPORTADO` antes de llamar al core — no se ignora en silencio.

**Files:**
- Create: `src/core/schemas/mipyme.ts`, `src/core/mipyme.ts`, `src/rest/rutas/mipyme.ts`
- Modify: `src/tools/mipyme.ts`, `src/restServer.ts`
- Test: `tests/core/mipyme.test.ts`, `tests/rest/rutas/mipyme.test.ts`

- [ ] **Step 1: Test del core**

Crear `tests/core/mipyme.test.ts`:

```typescript
import { listEmpresas, listDteEmitidos, emitirDte } from '../../src/core/mipyme';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/mipymeHttp');
const MockScraper = MipymeHttpScraper as jest.MockedClass<typeof MipymeHttpScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/mipyme', () => {
  afterEach(() => jest.clearAllMocks());

  it('listEmpresas llama al scraper sin argumentos', async () => {
    (MockScraper.prototype.listEmpresas as jest.Mock).mockResolvedValue([]);
    await listEmpresas(registroQueEjecuta(), '11.111.111-1');
    expect(MockScraper.prototype.listEmpresas).toHaveBeenCalledWith();
  });

  it('listDteEmitidos pasa los filtros tal cual', async () => {
    (MockScraper.prototype.listDteEmitidos as jest.Mock).mockResolvedValue({ documentos: [] });
    const filtros = { empresaRut: '22222222-2', pagina: 1 };
    await listDteEmitidos(registroQueEjecuta(), '11.111.111-1', filtros as any);
    expect(MockScraper.prototype.listDteEmitidos).toHaveBeenCalledWith(filtros);
  });

  it('emitirDte pasa los params y el flag confirmar', async () => {
    (MockScraper.prototype.emitirDte as jest.Mock).mockResolvedValue({ emitido: false, resumen: {} });
    const params = { empresaRut: '22222222-2' } as any;
    await emitirDte(registroQueEjecuta(), '11.111.111-1', params, false);
    expect(MockScraper.prototype.emitirDte).toHaveBeenCalledWith(params, false);
  });
});
```

- [ ] **Step 2: Correr y confirmar que falla.** Run: `npx jest tests/core/mipyme.test.ts` — FAIL.

- [ ] **Step 3: Schema**

Crear `src/core/schemas/mipyme.ts` — copiar tal cual de `src/tools/mipyme.ts` líneas 10, 14 (`RUT_DESC`, `FechaSchema`) y los tres bloques de schema (`sii_mipyme_list_empresas` líneas 33-35, `sii_mipyme_list_dte_emitidos` líneas 48-56, `sii_mipyme_emitir_dte` líneas 82-109), exportados como `schemaListEmpresas`, `schemaListDteEmitidos`, `schemaEmitirDte`. **Diferencia deliberada con la tool MCP:** en `schemaListDteEmitidos` y `schemaEmitirDte`, `empresa_rut` pasa a describirse sin mencionar `SII_EMPRESA_RUT` (esa env var no aplica a REST — ver limitación de la spec), y en ningún lado del schema de REST se referencia esa variable.

```typescript
import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';
const FechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Formato YYYY-MM-DD');

export const schemaListEmpresas = {
  rut: z.string().describe(RUT_DESC),
};

export const schemaListDteEmitidos = {
  rut: z.string().describe(RUT_DESC),
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa con dígito verificador. Si se omite, se resuelve solo si este RUT opera una única empresa en el portal.'),
  tipo_dte: z.number().int().optional().describe('Filtrar por tipo: 33=factura, 34=exenta, 61=N.crédito, 56=N.débito, 52=guía, 46=F.compra'),
  fecha_desde: FechaSchema,
  fecha_hasta: FechaSchema,
  receptor_rut: z.string().optional().describe('Filtrar por RUT del receptor'),
  folio: z.number().int().optional().describe('Filtrar por folio exacto'),
  pagina: z.number().int().min(1).default(1).describe('Página del historial (100 documentos por página)'),
};

export const schemaEmitirDte = {
  rut: z.string().describe(RUT_DESC),
  empresa_rut: z.string().optional()
    .describe('RUT empresa. Si se omite, se resuelve solo si la persona opera una única empresa.'),
  tipo_dte: z.number().int().describe('33=factura, 34=factura exenta, 61=nota de crédito'),
  receptor_rut: z.string().describe('RUT del receptor sin DV (ej: "33333333")'),
  receptor_dv: z.string().describe('DV del receptor (ej: "1" o "K")'),
  receptor_razon_social: z.string().describe('Razón social del receptor'),
  receptor_giro: z.string().describe('Giro del receptor'),
  receptor_direccion: z.string().describe('Dirección del receptor'),
  receptor_comuna: z.string().describe('Comuna del receptor'),
  receptor_ciudad: z.string().describe('Ciudad del receptor'),
  lineas: z.array(z.object({
    descripcion: z.string().max(25).describe('Descripción del ítem (máximo 25 caracteres: es el límite del portal)'),
    cantidad: z.number().describe('Cantidad'),
    precio_unitario: z.number().int().describe('Precio unitario sin IVA'),
    unidad: z.string().optional().describe('Unidad de medida (máximo 4 caracteres)'),
  })).min(1).describe('Líneas de detalle del documento'),
  forma_pago: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('1=contado, 2=crédito (default), 3=sin costo'),
  ciudad_emisor: z.string().optional().describe('Ciudad del emisor. El portal la exige y no la trae cargada; si se omite se usa su comuna.'),
  fecha_emision: FechaSchema.describe('Fecha de emisión YYYY-MM-DD. Si se omite, la del día que trae el portal.'),
  referencias: z.array(z.object({
    tipo_doc: z.number().int().describe('Tipo del documento referenciado: 33, 34, 39, 61, 56, 801...'),
    folio: z.number().int().describe('Folio del documento referenciado'),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha del documento referenciado, YYYY-MM-DD'),
    razon: z.string().max(90).optional().describe('Razón de la referencia'),
    codigo: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe('1=anula, 2=corrige texto, 3=corrige montos. Obligatorio en nota de crédito.'),
  })).max(3).optional().describe('Hasta 3 referencias. Una nota de crédito exige al menos una.'),
  confirmar: z.boolean().default(false).describe('false (default) = sólo previsualiza. true = FIRMA Y EMITE el documento, acto real e irreversible. NO SOPORTADO vía REST todavía — ver limitación conocida de la spec.'),
};
```

- [ ] **Step 4: Core**

Crear `src/core/mipyme.ts`:

```typescript
import { MipymeHttpScraper, FiltrosDteEmitidos, DteEmitidosResult, EmitirDteParams, PrevisualizacionDte, DteEmitido } from '../scrapers/mipymeHttp';
import { SiiHttpClient } from '../http';
import { SessionManager, Empresa } from '../session';
import { EjecutorSesion } from '../registroSesiones';

export async function listEmpresas(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string
): Promise<Empresa[]> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.listEmpresas();
  });
}

export async function listDteEmitidos(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  filtros: FiltrosDteEmitidos
): Promise<DteEmitidosResult> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.listDteEmitidos(filtros);
  });
}

export async function emitirDte(
  ejecutor: EjecutorSesion<SessionManager>,
  rut: string,
  params: EmitirDteParams,
  confirmar: boolean
): Promise<PrevisualizacionDte | DteEmitido> {
  return ejecutor.ejecutar(rut, async sesion => {
    const http = new MipymeHttpScraper(new SiiHttpClient(sesion), sesion);
    return http.emitirDte(params, confirmar);
  });
}
```

- [ ] **Step 5: Correr el test del core.** Run: `npx jest tests/core/mipyme.test.ts` — PASS.

- [ ] **Step 6: Actualizar `src/tools/mipyme.ts`**

`empresaPedida` (con el fallback `SII_EMPRESA_RUT`) **se conserva sin cambios** — sigue siendo comportamiento válido del MCP. Sólo cambia de dónde sale la lógica de scraping:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConfig } from '../env';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { envolverParaMcp } from '../erroresSesion';
import * as core from '../core/mipyme';
import { schemaListEmpresas, schemaListDteEmitidos, schemaEmitirDte } from '../core/schemas/mipyme';

// Orden de resolución de la empresa, el mismo que el resto del proyecto: el
// parámetro de la llamada gana, si no vino cae a SII_EMPRESA_RUT, y si tampoco
// hay, el scraper la resuelve solo cuando este RUT opera una única empresa
// (con varias, falla listándolas). Sólo aplica al MCP — el REST no tiene este
// fallback (ver src/rest/rutas/mipyme.ts).
function empresaPedida(empresaRut?: string): string | undefined {
  return empresaRut ?? getConfig().empresaRut;
}

export function registerMipymeTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_mipyme_list_empresas',
    /* ... copiar tal cual la descripción de src/tools/mipyme.ts líneas 28-32 ... */
    schemaListEmpresas,
    async ({ rut }) => envolverParaMcp(() => core.listEmpresas(registro, rut))
  );

  server.tool(
    'sii_mipyme_list_dte_emitidos',
    /* ... copiar tal cual la descripción de src/tools/mipyme.ts líneas 41-46 ... */
    schemaListDteEmitidos,
    async ({ rut, empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, folio, pagina }) =>
      envolverParaMcp(() => core.listDteEmitidos(registro, rut, {
        empresaRut: empresaPedida(empresa_rut), tipoDte: tipo_dte, fechaDesde: fecha_desde,
        fechaHasta: fecha_hasta, receptorRut: receptor_rut, folio, pagina,
      }))
  );

  server.tool(
    'sii_mipyme_emitir_dte',
    /* ... copiar tal cual la descripción de src/tools/mipyme.ts líneas 71-80 ... */
    schemaEmitirDte,
    async (args) => envolverParaMcp(async () => {
      const resultado = await core.emitirDte(registro, args.rut, {
        empresaRut: empresaPedida(args.empresa_rut),
        tipoDte: args.tipo_dte,
        receptor: {
          rut: args.receptor_rut, dv: args.receptor_dv, razonSocial: args.receptor_razon_social,
          giro: args.receptor_giro, direccion: args.receptor_direccion, comuna: args.receptor_comuna,
          ciudad: args.receptor_ciudad,
        },
        lineas: args.lineas.map(l => ({
          nombre: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precio_unitario, unidad: l.unidad,
        })),
        formaPago: args.forma_pago,
        ciudadEmisor: args.ciudad_emisor,
        fechaEmision: args.fecha_emision,
        referencias: args.referencias?.map(r => ({
          tipoDoc: r.tipo_doc, folio: r.folio, fecha: r.fecha, razon: r.razon, codigo: r.codigo,
        })),
      }, args.confirmar);

      return resultado.emitido
        ? {
            emitido: true, folio: resultado.folio, resumen: resultado.resumen,
            aviso: `Documento emitido. El folio ${resultado.folio} es el que propuso el ` +
              'portal; hay que verificar que quedó asignado consultando ' +
              'sii_mipyme_list_dte_emitidos (la respuesta del envío aún no está relevada).',
          }
        : {
            emitido: false, resumen: resultado.resumen,
            aviso: 'Documento NO emitido: esto es sólo la previsualización. Para emitirlo de ' +
              'verdad hay que llamar de nuevo con confirmar=true, y eso es irreversible.',
          };
    })
  );
}
```

- [ ] **Step 7: Correr tests existentes + suite.** Run: `npx jest tests/tools/mipyme.test.ts && npm test` — PASS.

- [ ] **Step 8: Test de la ruta REST**

Crear `tests/rest/rutas/mipyme.test.ts`:

```typescript
import { registrarRutasMipyme } from '../../../src/rest/rutas/mipyme';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/mipyme';

jest.mock('../../../src/core/mipyme');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasMipyme(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

const LINEA_MINIMA = { descripcion: 'Item', cantidad: 1, precio_unitario: 1000 };
const RECEPTOR_MINIMO = {
  receptor_rut: '33333333', receptor_dv: '1', receptor_razon_social: 'Test',
  receptor_giro: 'Giro', receptor_direccion: 'Calle 1', receptor_comuna: 'Santiago', receptor_ciudad: 'Santiago',
};

describe('registrarRutasMipyme', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 3 rutas bajo /v1/mipyme', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual([
      'POST /v1/mipyme/list-empresas', 'POST /v1/mipyme/list-dte-emitidos', 'POST /v1/mipyme/emitir-dte',
    ]);
  });

  it('list-empresas: body válido llama al core', async () => {
    (core.listEmpresas as jest.Mock).mockResolvedValue([]);
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/list-empresas')!({ rut: '11.111.111-1', clave: 'x' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true } });
  });

  it('emitir-dte con confirmar=false (default) llama al core en modo previsualización', async () => {
    (core.emitirDte as jest.Mock).mockResolvedValue({ emitido: false, resumen: {} });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: 'x', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO,
    });
    expect(respuesta.status).toBe(200);
    expect(core.emitirDte).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', expect.any(Object), false);
  });

  it('emitir-dte con confirmar=true responde 400 CONFIRMAR_NO_SOPORTADO sin llamar al core', async () => {
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/mipyme/emitir-dte')!({
      rut: '11.111.111-1', clave: 'x', tipo_dte: 33, lineas: [LINEA_MINIMA], ...RECEPTOR_MINIMO, confirmar: true,
    });
    expect(respuesta).toEqual({ status: 400, body: { error: 'CONFIRMAR_NO_SOPORTADO' } });
    expect(core.emitirDte).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 9: Correr y confirmar que falla.** Run: `npx jest tests/rest/rutas/mipyme.test.ts` — FAIL.

- [ ] **Step 10: Implementar la ruta**

Crear `src/rest/rutas/mipyme.ts`:

```typescript
import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/mipyme';
import { schemaListEmpresas, schemaListDteEmitidos, schemaEmitirDte } from '../../core/schemas/mipyme';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler } from './rcv';

const zodListEmpresas = z.object(schemaListEmpresas).extend({ clave: z.string().min(1) });
const zodListDteEmitidos = z.object(schemaListDteEmitidos).extend({ clave: z.string().min(1) });
const zodEmitirDte = z.object(schemaEmitirDte).extend({ clave: z.string().min(1) });

async function ejecutar<R>(fn: () => Promise<R>) {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasMipyme(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/mipyme/list-empresas', async body => {
    const parseo = zodListEmpresas.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listEmpresas(ejecutor, rut));
  });

  rutas.set('POST /v1/mipyme/list-dte-emitidos', async body => {
    const parseo = zodListDteEmitidos.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, folio, pagina } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listDteEmitidos(ejecutor, rut, {
      empresaRut: empresa_rut, tipoDte: tipo_dte, fechaDesde: fecha_desde,
      fechaHasta: fecha_hasta, receptorRut: receptor_rut, folio, pagina,
    }));
  });

  // sii_mipyme_emitir_dte con confirmar=true firma con certificado digital,
  // cuya clave hoy sólo se configura vía env vars del PROCESO
  // (SII_CERT_CLAVE_SII/SII_CERT_PASSWORD) — incompatible con credencial por
  // request. Rechazo explícito, no silencioso: un caller que mande
  // confirmar=true merece saber que no se soporta, no una previsualización
  // sorpresa. Ver limitación conocida de la spec y el pendiente de
  // certificado digital en la memoria del proyecto.
  rutas.set('POST /v1/mipyme/emitir-dte', async body => {
    const parseo = zodEmitirDte.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const datos = parseo.data;
    if (datos.confirmar) {
      return { status: 400, body: { error: 'CONFIRMAR_NO_SOPORTADO' } };
    }

    const ejecutor = ejecutorPassThroughDe(registro, credenciales, datos.rut, datos.clave);
    return ejecutar(() => core.emitirDte(ejecutor, datos.rut, {
      empresaRut: datos.empresa_rut,
      tipoDte: datos.tipo_dte,
      receptor: {
        rut: datos.receptor_rut, dv: datos.receptor_dv, razonSocial: datos.receptor_razon_social,
        giro: datos.receptor_giro, direccion: datos.receptor_direccion, comuna: datos.receptor_comuna,
        ciudad: datos.receptor_ciudad,
      },
      lineas: datos.lineas.map(l => ({
        nombre: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precio_unitario, unidad: l.unidad,
      })),
      formaPago: datos.forma_pago,
      ciudadEmisor: datos.ciudad_emisor,
      fechaEmision: datos.fecha_emision,
      referencias: datos.referencias?.map(r => ({
        tipoDoc: r.tipo_doc, folio: r.folio, fecha: r.fecha, razon: r.razon, codigo: r.codigo,
      })),
    }, false));
  });
}
```

- [ ] **Step 11: Correr y confirmar que pasa.** Run: `npx jest tests/rest/rutas/mipyme.test.ts` — PASS.

- [ ] **Step 12: Montar en `restServer.ts`**

Agregar `import { registrarRutasMipyme } from './rest/rutas/mipyme';` y, en `crearRestServer`, `registrarRutasMipyme(rutas, registro, credenciales);`.

- [ ] **Step 13: Suite completa.** Run: `npm test` — PASS.

- [ ] **Step 14: Commit**

```bash
git add src/core/schemas/mipyme.ts src/core/mipyme.ts src/tools/mipyme.ts src/rest/rutas/mipyme.ts src/restServer.ts tests/core/mipyme.test.ts tests/rest/rutas/mipyme.test.ts
git commit -m "feat: migrar dominio Mipyme a core+schema; REST rechaza confirmar=true explícito"
```

---

### Task 7: Absorber `validar-clave` como `/v1/sesion/validar-clave`

**Files:**
- Create: `src/rest/rutas/sesion.ts`
- Modify: `src/restServer.ts`
- Test: `tests/rest/rutas/sesion.test.ts`

**Interfaces:**
- Produces: `registrarRutasSesion(rutas, registro, credenciales)`, reusando `validarClave` de `src/httpServer.ts` **tal cual** (no se reescribe su lógica, sólo se le agrega una ruta HTTP encima) hasta la Task 9, donde `httpServer.ts` se elimina y `validarClave` se muda a `sesion.ts` directamente.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/rest/rutas/sesion.test.ts`:

```typescript
import { registrarRutasSesion } from '../../../src/rest/rutas/sesion';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';

function armarRouter(sesion: { authenticateOnly: jest.Mock; logout: jest.Mock }) {
  const rutas = new Map<string, Function>();
  const registro = {
    ejecutarPassThrough: async (_rut: string, preparar: () => void, finalizar: () => void, fn: any) => {
      preparar();
      try { return await fn(sesion); } finally { finalizar(); }
    },
  } as unknown as RegistroSesiones<any>;
  registrarRutasSesion(rutas as any, registro, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasSesion', () => {
  it('registra POST /v1/sesion/validar-clave', () => {
    const rutas = armarRouter({ authenticateOnly: jest.fn(), logout: jest.fn() });
    expect([...rutas.keys()]).toEqual(['POST /v1/sesion/validar-clave']);
  });

  it('clave correcta: responde {ok:true}', async () => {
    const rutas = armarRouter({
      authenticateOnly: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    });
    const respuesta = await rutas.get('POST /v1/sesion/validar-clave')!({ rut: '11.111.111-1', clave: 'x' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true } });
  });

  it('body inválido devuelve 400', async () => {
    const rutas = armarRouter({ authenticateOnly: jest.fn(), logout: jest.fn() });
    const respuesta = await rutas.get('POST /v1/sesion/validar-clave')!({ rut: '11.111.111-1' });
    expect(respuesta.status).toBe(400);
  });
});
```

- [ ] **Step 2: Correr y confirmar que falla.** Run: `npx jest tests/rest/rutas/sesion.test.ts` — FAIL.

- [ ] **Step 3: Implementar**

Crear `src/rest/rutas/sesion.ts`:

```typescript
import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import { validarClave } from '../../httpServer';
import { RutaHandler } from './rcv';

const zodValidarClave = z.object({ rut: z.string(), clave: z.string().min(1) });

export function registrarRutasSesion(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/sesion/validar-clave', async body => {
    const parseo = zodValidarClave.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave } = parseo.data;
    const resultado = await validarClave(rut, clave, registro, credenciales);
    return { status: 200, body: resultado };
  });
}
```

- [ ] **Step 4: Correr y confirmar que pasa.** Run: `npx jest tests/rest/rutas/sesion.test.ts` — PASS.

- [ ] **Step 5: Montar en `restServer.ts`**

Agregar `import { registrarRutasSesion } from './rest/rutas/sesion';` y, en `crearRestServer`, `registrarRutasSesion(rutas, registro, credenciales);`.

- [ ] **Step 6: Suite completa.** Run: `npm test` — PASS.

- [ ] **Step 7: Commit**

```bash
git add src/rest/rutas/sesion.ts src/restServer.ts tests/rest/rutas/sesion.test.ts
git commit -m "feat: absorber validar-clave como POST /v1/sesion/validar-clave"
```

---

### Task 8: Retirar `httpServer.ts`/`httpServerIndex.ts`/`apiKey.ts`

Ahora que `validar-clave` vive en el REST nuevo, el proceso HTTP viejo (con su propia API key fija por env var) queda sin motivo — todo tráfico pasa por `restServerIndex.ts`.

**Files:**
- Modify: `src/rest/rutas/sesion.ts` (mueve `validarClave` acá, ya no importa de `httpServer.ts`)
- Delete: `src/httpServer.ts`, `src/httpServerIndex.ts`, `src/apiKey.ts`
- Delete: `tests/httpServer.test.ts`, `tests/apiKey.test.ts` (sus casos relevantes ya están cubiertos por `tests/rest/rutas/sesion.test.ts` — Step 2 de esta task agrega los que falten)
- Modify: `package.json` (quita `start:validar-clave`)

- [ ] **Step 1: Mover `validarClave` a `src/rest/rutas/sesion.ts`**

Cortar la función `validarClave` completa (con su comentario) de `src/httpServer.ts` y pegarla en `src/rest/rutas/sesion.ts`, ajustando el import de `clasificarErrorCredenciales` (ya está en el archivo destino o se agrega). Cambiar el import en `registrarRutasSesion` de `import { validarClave } from '../../httpServer';` a que `validarClave` sea una función local del mismo archivo (ya no un import).

- [ ] **Step 2: Portar los tests de `validarClave` que no estén ya cubiertos**

Revisar `tests/httpServer.test.ts` (los 6 tests de `describe('validarClave', ...)`) contra lo que ya cubre `tests/rest/rutas/sesion.test.ts`. Los casos que falten (clave rechazada por el SII, fallo de infraestructura, logout falla pero no contamina el resultado, credencial atómica dentro de `ejecutarPassThrough`) se agregan a `tests/rest/rutas/sesion.test.ts`, adaptando el mock de `armarRouter` de esa task (ya soporta `authenticateOnly`/`logout` configurables).

- [ ] **Step 3: Correr los tests movidos**

Run: `npx jest tests/rest/rutas/sesion.test.ts`
Expected: PASS con la cobertura completa.

- [ ] **Step 4: Eliminar los archivos viejos**

```bash
git rm src/httpServer.ts src/httpServerIndex.ts src/apiKey.ts tests/httpServer.test.ts tests/apiKey.test.ts
```

- [ ] **Step 5: Quitar el script de `package.json`**

Eliminar la línea `"start:validar-clave": "node dist/src/httpServerIndex.js",`.

- [ ] **Step 6: Build y suite completa**

Run: `npm run build && npm test`
Expected: build sin errores (nada más importa `httpServer.ts`/`apiKey.ts` — si el build falla acá, hay un import colgante que hay que corregir antes de seguir), tests en verde.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: retirar httpServer.ts/httpServerIndex.ts/apiKey.ts — validar-clave vive en restServer.ts"
```

---

### Task 9: Limpieza final — retirar `crearConScraper`

Con los 6 dominios migrados (RCV en PR #33, los 5 de este plan), `crearConScraper` ya no tiene callers.

**Files:**
- Modify: `src/erroresSesion.ts`

- [ ] **Step 1: Confirmar que no queda ningún caller**

Run: `grep -rn "crearConScraper" src/ tests/`
Expected: sólo la definición en `src/erroresSesion.ts` y, si quedó, su propio test — nada en `src/tools/*.ts`.

Si aparece un caller que este plan no migró, **detenerse acá** — significa que algún dominio quedó sin migrar y hay que revisar antes de borrar la función.

- [ ] **Step 2: Eliminar la función y su test dedicado (si lo tiene)**

Borrar `crearConScraper` de `src/erroresSesion.ts`. Revisar `tests/erroresSesion.test.ts` por cualquier `describe('crearConScraper', ...)` y borrarlo también (los casos ya están cubiertos indirectamente por los tests de cada dominio contra `envolverParaMcp`).

- [ ] **Step 3: Build y suite completa**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/erroresSesion.ts tests/erroresSesion.test.ts
git commit -m "refactor: retirar crearConScraper — sin callers, todos los dominios migraron a core+envolverParaMcp"
```

---

### Task 10: Verificación end-to-end manual

**Files:** ninguno.

- [ ] **Step 1: Levantar Postgres, migrar, crear tenant, levantar el REST**

```bash
docker compose -f docker-compose.test.yml up -d
export DATABASE_URL="postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test"
npm run build
npm run db:migrar
npm run crear-tenant -- --nombre prueba
PORT=8790 npm run start:rest
```

- [ ] **Step 2: Probar al menos una ruta de cada dominio migrado**

```bash
API_KEY="<la que imprimió crear-tenant>"

curl -s -X POST http://localhost:8790/v1/bhe/resumen \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"clave-de-prueba","anio":2026}'

curl -s -X POST http://localhost:8790/v1/renta/estado-declaracion \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"clave-de-prueba","anio":2026}'

curl -s -X POST http://localhost:8790/v1/persona/bienes-raices \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"clave-de-prueba"}'

curl -s -X POST http://localhost:8790/v1/dte/list-documentos-emitidos \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"clave-de-prueba","periodo":"202607"}'

curl -s -X POST http://localhost:8790/v1/mipyme/list-empresas \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"clave-de-prueba"}'

curl -s -X POST http://localhost:8790/v1/sesion/validar-clave \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"clave-de-prueba"}'
```

Expected: cada una responde `{"ok":true,...}` o `{"ok":false,"error":"CREDENCIALES_INVALIDAS"}` — nunca un 500 ni un crash del proceso.

- [ ] **Step 3: Confirmar que `confirmar=true` en mipyme se rechaza**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8790/v1/mipyme/emitir-dte \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"x","tipo_dte":33,"receptor_rut":"1","receptor_dv":"1","receptor_razon_social":"x","receptor_giro":"x","receptor_direccion":"x","receptor_comuna":"x","receptor_ciudad":"x","lineas":[{"descripcion":"x","cantidad":1,"precio_unitario":1000}],"confirmar":true}'
```

Expected: `400`.

- [ ] **Step 4: Confirmar que el MCP stdio sigue funcionando sin cambios**

```bash
npm run dev
```

(Conectar con un cliente MCP cualquiera, o confirmar que arranca sin error — el objetivo es que `src/server.ts`/`src/index.ts` no se hayan roto por los cambios de firma en `registerBienesRaicesTools`.)

- [ ] **Step 5: Apagar todo**

```bash
# Ctrl+C en las terminales de npm run start:rest y npm run dev
docker compose -f docker-compose.test.yml down
```

No hay commit en esta task.

---

## Self-Review

**Cobertura del spec:**
- Los 16 tools MCP existentes tienen su ruta REST equivalente → Tasks 2-7 (RCV ya en PR #33).
- Fallback `SII_EMPRESA_RUT` eliminado en las rutas REST de mipyme → Task 6.
- `sii_mipyme_emitir_dte` con `confirmar=true` bloqueado en REST con rechazo explícito → Task 6.
- `validar-clave` absorbido, `httpServer.ts`/`httpServerIndex.ts` retirados → Tasks 7-8.
- Schemas compartidos entre MCP y REST, sin duplicar → todas las tasks de dominio.
- `EjecutorSesion<T>` (de PR #33) reusado para pass-through en cada dominio nuevo → todas las tasks de dominio.

**Explícitamente fuera de este plan:** Secrets Manager, egress IP, retención de tablas, idempotencia de `emitir-dte`, certificado digital multi-tenant — todos ya documentados como fuera de alcance en la spec o en memoria del proyecto.

**Placeholders:** los únicos bloques marcados como "copiar tal cual" (Tasks 5 y 6, para las descripciones largas de `server.tool(...)` y algunos bloques de schema) no son placeholders de lógica — son instrucciones de mover texto literal ya existente y completo en los archivos que se reemplazan, con la ubicación exacta (archivo + rango de líneas) citada. El resto del código en cada task está completo.

**Consistencia de tipos:** `EjecutorSesion<T>` (definida en PR #33, `src/registroSesiones.ts`) se usa con la misma firma en `core/bhe.ts`, `core/renta.ts`, `core/bienesRaices.ts`, `core/dte.ts`, `core/mipyme.ts`. `RutaHandler` (definida en PR #33, `src/rest/rutas/rcv.ts`) se importa igual en las 6 rutas nuevas. `ejecutorPassThroughDe` — que en el PR #33 vivía sólo en `rest/rutas/rcv.ts` — se extrae en la Task 1 a `src/rest/ejecutorPassThrough.ts` antes de que los 5 dominios nuevos la necesiten cada uno: se sabe de entrada que van a ser 6 consumidores, así que corresponde extraerla ahí y no dejarla copiada 6 veces esperando a un séptimo caso (a diferencia de una duplicación que aparece de a una, acá el plan entero ya sabe cuántos consumidores va a tener).
