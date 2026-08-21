# Homologación apigateway v2 — Sub-proyecto 1 (empresa, lectura) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exponer vía REST y MCP los servicios de EMPRESA de solo lectura del catálogo apigateway.cl v2 (RCV async, F29, mipyme lectura, contribuyentes públicos), sobre la arquitectura de sesión + scraping existente.

**Architecture:** Cada dominio sigue el patrón vigente `src/core/<d>.ts` (lógica, tipada contra `EjecutorSesion`) + `src/core/schemas/<d>.ts` (schemas zod compartidos MCP/REST) + `src/tools/<d>.ts` (adaptador MCP, `envolverParaMcp`) + `src/rest/rutas/<d>.ts` (adaptador REST, `ejecutar`+`ejecutorPassThroughDe`). El scraping HTTP usa `SiiHttpClient` sobre el cookie jar de la sesión. Una fase 0 previa hace que el login por CLAVE (no solo certificado) produzca ese cookie jar, sin lo cual ninguna ruta REST con clave funciona.

**Tech Stack:** TypeScript, Node 24, zod, jest, pg (Neon), agent-browser (Chromium), curl (vía execFileSync).

**Spec:** `docs/superpowers/specs/2026-08-21-homologacion-empresa-lectura-design.md`

## Global Constraints

- Contrato REST: `{ok:true, ...datos}` en éxito, `{ok:false, error:CODIGO}` en fallo, siempre HTTP 200 salvo `BAD_REQUEST`/`PAYLOAD_TOO_LARGE` (400/413). Rutas `POST /v1/<dominio>/<accion>`.
- Toda ruta REST recibe `rut`, `clave` y (según dominio) `empresa_rut?`, salvo el dominio `contribuyentes` (sin credencial de SII).
- Errores de negocio uniformes: `NO_ENCONTRADO` (folio/código inexistente), `RUT_INVALIDO` (contribuyentes), además de los vigentes `BAD_REQUEST`/`CREDENCIALES_INVALIDAS`/`ERROR`.
- PDFs/XML como `{ok, pdfBase64|xmlBase64, contentType}`; validar magic bytes `%PDF` antes de encodear.
- TDD estricto, un PR por dominio, `maxWorkers:1` en jest (infra comparte DB). Tests de infra requieren `TEST_DATABASE_URL` (Docker Postgres, `docker-compose.test.yml`, puerto 55432, `mcp_sii:mcp_sii@.../mcp_sii_test`).
- RUTs en fixtures/tests: solo de dígito repetido (11111111-1, etc.) — el test `tests/anonimizacion.test.ts` rechaza RUTs reales en archivos versionados.
- Verificación e2e real por dominio: credenciales del `.env` (persona 17.270.613-4, empresa 78122544-4) + comparación con apigateway v1 (`APIGATEWAY_TOKEN` en `.env`) antes de cada PR.
- Comentarios y mensajes en español, sin em-dash en nombres de recursos AWS.

---

## FASE 0 — Cookie jar desde login por clave (prerrequisito)

Sin esto, las rutas REST de rcv/renta/bhe/dte/mipyme YA EN PRODUCCIÓN devuelven `ERROR` con cualquier clave válida (los scrapers HTTP exigen el jar que hoy solo escribe `loginWithCert`). Es un bug de prod además de un prerrequisito.

### Task 0.1: Spike — ¿document.cookie entrega las cookies de sesión del SII tras login por clave?

**Files:**
- Create (throwaway): `src/scripts/spikeCookiesClave.ts`

**Interfaces:**
- Consumes: `SessionManager` (`src/session.ts:101`), `Browser` (`src/browser.ts:7`), `getConfig` (`src/env.ts:52`).
- Produces: respuesta sí/no + lista de cookies observadas. No deja código productivo.

- [ ] **Step 1: Escribir el script de spike**

```typescript
import 'dotenv/config';
import { Browser } from '../browser';
import { SessionManager } from '../session';
import { AuthStrategy } from '../env';

// Fuerza estrategia clave aunque el .env tenga certificado, para el spike.
async function main() {
  const rut = process.env.SII_RUT!;
  const clave = process.env.SII_CLAVE!;
  const browser = new Browser(rut);
  const session = new SessionManager({ rut, clave, strategy: AuthStrategy.Clave }, browser);
  await session.authenticateOnly();
  // Leer document.cookie en dominio .sii.cl
  browser.open('https://www.sii.cl');
  const cookies = browser.eval('document.cookie');
  console.log('COOKIES VISIBLES:', cookies);
  await session.logout().catch(() => {});
}
main().catch(e => { console.error('SPIKE ERROR:', e.message); process.exit(1); });
```

- [ ] **Step 2: Correr con la clave real**

Run: `npx ts-node src/scripts/spikeCookiesClave.ts`
Expected: imprime `COOKIES VISIBLES: ...`. Registrar QUÉ cookies aparecen (esperado: `NETSCAPE_LIVEWIRE.*`, `TOKEN`, etc.) y CUÁLES de `SII_SESSION_COOKIES` (`src/session.ts:35-49`) faltan.

- [ ] **Step 3: Decidir camino y registrar hallazgo**

Si aparecen `TOKEN` + `NETSCAPE_LIVEWIRE.mac`/`exp` → camino A (document.cookie), seguir a 0.2.
Si falta `TOKEN` u otra imprescindible (httpOnly) → camino B: usar CDP (`agent-browser get cdp-url` + `Network.getCookies`). Anotar la decisión en un comentario al inicio de 0.2 y ajustar `exportarCookiesAlJar` en consecuencia.
Anotar el SUBCONJUNTO MÍNIMO de cookies imprescindibles observado (se usa en 0.3).

- [ ] **Step 4: Borrar el script de spike**

```bash
rm src/scripts/spikeCookiesClave.ts
```

### Task 0.2: `exportarCookiesAlJar` en SessionManager

**Files:**
- Modify: `src/session.ts` (agregar método privado + llamada en `authenticate` `:230-243`; usa `parseCookieFile` `:460`, `cookieJar` getter `:149`, `SII_SESSION_COOKIES` `:35-49`)
- Test: `tests/session.exportarCookies.test.ts`

**Interfaces:**
- Consumes: `Browser.eval` (`src/browser.ts:74`), `fs`, `rutaTemporalSii` (`src/rutaTemporalSii.ts:14`).
- Produces: `private exportarCookiesAlJar(): void` — lee `document.cookie`, escribe el jar Netscape en `this.cookieJar` con formato de 7 campos TAB, dominio `.sii.cl`, flag `TRUE`, expiry `0`, sin prefijo `#HttpOnly_`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';
import * as fs from 'fs';
import { rutaTemporalSii } from '../src/rutaTemporalSii';

jest.mock('../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;
const cfg: SiiConfig = { rut: '11111111-1', strategy: AuthStrategy.Clave, clave: 'x' };

it('exportarCookiesAlJar escribe el jar Netscape con las cookies de document.cookie', () => {
  const browser = new MockBrowser();
  (browser.eval as jest.Mock).mockReturnValue('TOKEN=abc123; NETSCAPE_LIVEWIRE.mac=deadbeef');
  const s = new SessionManager(cfg, browser);
  (s as any).exportarCookiesAlJar();

  const jar = fs.readFileSync(rutaTemporalSii('cookies', '11111111-1'), 'utf-8');
  const lineas = jar.trim().split('\n').filter(l => !l.startsWith('#'));
  const token = lineas.find(l => l.includes('\tTOKEN\t'));
  expect(token).toBe('.sii.cl\tTRUE\t/\tTRUE\t0\tTOKEN\tabc123');
  expect(lineas.some(l => l.endsWith('\tNETSCAPE_LIVEWIRE.mac\tdeadbeef'))).toBe(true);
});

afterAll(() => { try { fs.unlinkSync(rutaTemporalSii('cookies', '11111111-1')); } catch {} });
```

- [ ] **Step 2: Correr, verificar que falla**

Run: `npx jest tests/session.exportarCookies.test.ts`
Expected: FAIL — `exportarCookiesAlJar is not a function`.

- [ ] **Step 3: Implementar el método**

En `src/session.ts`, después de `setLocExpCookie` (`:452`):

```typescript
// Exporta las cookies de sesión visibles en document.cookie al cookie jar
// Netscape que curl (SiiHttpClient) espera. Necesario para que el login por
// CLAVE (que corre en el browser) produzca el jar que hoy solo escribe
// loginWithCert. Formato de 7 campos TAB; dominio .sii.cl + flag TRUE para
// que curl las mande a todos los subdominios (www4, zeusr, www1, ...);
// expiry 0 = cookie de sesión. NUNCA prefijo #HttpOnly_: parseCookieFile
// saltea líneas con '#' y rompería conversationId().
private exportarCookiesAlJar(): void {
  this.browser.open('https://www.sii.cl');
  const crudo = this.browser.eval('document.cookie'); // "a=1; b=2"
  const lineas: string[] = [];
  for (const par of crudo.split(';')) {
    const idx = par.indexOf('=');
    if (idx <= 0) continue;
    const nombre = par.slice(0, idx).trim();
    const valor = par.slice(idx + 1).trim();
    if (!nombre) continue;
    lineas.push(['.sii.cl', 'TRUE', '/', 'TRUE', '0', nombre, valor].join('\t'));
  }
  const jar = this.cookieJar;
  try { fs.unlinkSync(jar); } catch { /* no existía */ }
  fs.writeFileSync(jar, lineas.join('\n') + '\n', 'utf-8');
}
```

- [ ] **Step 4: Llamarlo en el camino de clave de `authenticate`**

Modificar `src/session.ts:235-239`:

```typescript
    } else {
      this.browser.open(SII_LOGIN_URL);
      const loginSnapshot = this.browser.snapshot();
      await this.fillClaveForm(loginSnapshot);
      this.exportarCookiesAlJar();
    }
```

- [ ] **Step 5: Correr, verificar que pasa**

Run: `npx jest tests/session.exportarCookies.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/session.ts tests/session.exportarCookies.test.ts
git commit -m "feat: exportar cookies del login por clave al cookie jar (fase 0)"
```

### Task 0.3: `assertPuedeEntregarCookieJar` por capacidad + `assertPuedeFirmar`

**Files:**
- Modify: `src/session.ts:325-342` (relajar assert), agregar `assertPuedeFirmar`
- Modify: `src/scrapers/mipymeHttp.ts:420,576` (emitir/verificarFirma llaman `assertPuedeFirmar`)
- Test: `tests/session.asserts.test.ts`

**Interfaces:**
- Produces: `assertPuedeEntregarCookieJar()` ya NO exige Certificate (acepta Clave y Certificate); `assertPuedeFirmar(): void` lanza `RequiereCertificado` si la estrategia no es Certificate o falta `claveCertificadoSii`.
- Consumes: `AuthStrategy` (`src/env.ts`), `RequiereCertificado` (`src/session.ts:99`).

- [ ] **Step 1: Escribir tests que fallan**

```typescript
import { SessionManager, RequiereCertificado } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';
jest.mock('../src/browser');
const MB = Browser as jest.MockedClass<typeof Browser>;

it('assertPuedeEntregarCookieJar acepta estrategia Clave (ya no exige certificado)', () => {
  const s = new SessionManager({ rut: '1-9', strategy: AuthStrategy.Clave, clave: 'x' } as SiiConfig, new MB());
  expect(() => s.assertPuedeEntregarCookieJar()).not.toThrow();
});

it('assertPuedeFirmar exige certificado + claveCertificadoSii', () => {
  const clave = new SessionManager({ rut: '1-9', strategy: AuthStrategy.Clave, clave: 'x' } as SiiConfig, new MB());
  expect(() => (clave as any).assertPuedeFirmar()).toThrow(RequiereCertificado);
  const certSinClave = new SessionManager({ rut: '1-9', strategy: AuthStrategy.Certificate, certPath: '/x', certPassword: 'y' } as SiiConfig, new MB());
  expect(() => (certSinClave as any).assertPuedeFirmar()).toThrow(RequiereCertificado);
  const ok = new SessionManager({ rut: '1-9', strategy: AuthStrategy.Certificate, certPath: '/x', certPassword: 'y', claveCertificadoSii: 'z' } as SiiConfig, new MB());
  expect(() => (ok as any).assertPuedeFirmar()).not.toThrow();
});
```

- [ ] **Step 2: Correr, verificar que falla**

Run: `npx jest tests/session.asserts.test.ts`
Expected: FAIL — el primer test lanza `RequiereCertificado` (assert viejo), `assertPuedeFirmar` no existe.

- [ ] **Step 3: Reescribir `assertPuedeEntregarCookieJar` y agregar `assertPuedeFirmar`**

Reemplazar el cuerpo de `assertPuedeEntregarCookieJar` (`src/session.ts:325-342`):

```typescript
  // El jar lo puede producir tanto el login por certificado (loginWithCert)
  // como el login por clave (exportarCookiesAlJar). Se valida por CAPACIDAD
  // de la estrategia, no por existencia del archivo: este assert se llama
  // ANTES de autenticar (el jar de una sesión por clave todavía no existe),
  // y un jar viejo presente traería cookies muertas (bloqueo
  // 01.01.190.500.720.27).
  assertPuedeEntregarCookieJar(): void {
    const s = this.config.strategy;
    if (s !== AuthStrategy.Certificate && s !== AuthStrategy.Clave) {
      throw new RequiereCertificado(
        'Esta consulta requiere una sesión autenticada (clave o certificado).'
      );
    }
  }

  // Firmar/emitir DTE SÍ requiere certificado (la firma es server-side con la
  // clave del certificado centralizado). Guard temprano para que una sesión
  // por clave falle acá y no en medio de armar el documento.
  assertPuedeFirmar(): void {
    if (this.config.strategy !== AuthStrategy.Certificate || !this.config.claveCertificadoSii) {
      throw new RequiereCertificado(
        'Emitir o firmar un DTE requiere certificado digital (SII_CERT_PATH + SII_CERT_CLAVE_SII).'
      );
    }
  }
```

- [ ] **Step 4: Llamar `assertPuedeFirmar` en emisión/firma mipyme**

En `src/scrapers/mipymeHttp.ts:420` (emitirDte) y `:576` (verificarFirma), agregar `this.session.assertPuedeFirmar();` justo después del `assertPuedeEntregarCookieJar()` existente.

- [ ] **Step 5: Correr tests + reescribir los que fijaban el contrato viejo**

Run: `npx jest tests/session.asserts.test.ts tests/scrapers/bhe.sesion.test.ts`
Expected: los nuevos PASAN; los tests de `bhe.sesion.test.ts` (y mocks en renta/dte/rcv/mipymeHttp tests) que esperaban `RequiereCertificado` para CONSULTA por clave ahora fallan — reescribirlos para el contrato nuevo (consulta por clave funciona; solo firma exige certificado). Ajustar hasta verde.

- [ ] **Step 6: Commit**

```bash
git add src/session.ts src/scrapers/mipymeHttp.ts tests/
git commit -m "feat: cookie jar por capacidad de estrategia + assertPuedeFirmar (fase 0)"
```

### Task 0.4: Browser por RUT en el registro MCP (carrera multi-RUT)

**Files:**
- Modify: `src/registroSesionesSii.ts:14-21`, `src/server.ts:13,20`

**Interfaces:**
- Consumes: `Browser` con `sessionId` (`src/browser.ts:8`).
- Produces: `crearRegistroSesionesSii(proveedor)` — ya NO recibe un Browser compartido; crea `new Browser(rut)` por RUT dentro de la factory.

- [ ] **Step 1: Test que falla — cada RUT recibe su propio Browser**

```typescript
// tests/registroSesionesSii.test.ts
import { crearRegistroSesionesSii } from '../src/registroSesionesSii';
import { Browser } from '../src/browser';
jest.mock('../src/browser');

it('crea un Browser con sessionId por RUT, no uno compartido', async () => {
  const proveedor = { para: async (rut: string) => ({ rut, strategy: 'clave', clave: 'x' }) } as any;
  const registro = crearRegistroSesionesSii(proveedor);
  await registro.ejecutar('11111111-1', async () => {});
  await registro.ejecutar('22222222-2', async () => {});
  const rutsUsados = (Browser as jest.Mock).mock.calls.map(c => c[0]);
  expect(rutsUsados).toEqual(expect.arrayContaining(['11111111-1', '22222222-2']));
});
```

- [ ] **Step 2: Correr, verificar que falla**

Run: `npx jest tests/registroSesionesSii.test.ts`
Expected: FAIL (hoy `crearRegistroSesionesSii` recibe el browser por parámetro y lo comparte).

- [ ] **Step 3: Implementar**

`src/registroSesionesSii.ts`:

```typescript
export function crearRegistroSesionesSii(
  proveedor: ProveedorCredenciales
): RegistroSesiones<SessionManager> {
  return new RegistroSesiones(async (rut: string) => {
    const config = await proveedor.para(rut);
    // Browser por RUT (--session <rut>), no compartido: con login por clave
    // la sesión vive en las cookies del browser, y un browser compartido deja
    // que el login de un RUT pise las cookies de otro (datos cruzados).
    return new SessionManager(config, new Browser(rut));
  });
}
```

`src/server.ts`: eliminar `const browser = new Browser();` (`:13`) y pasar `crearRegistroSesionesSii(credenciales)` (`:20`, sin browser). Verificar que `registerBienesRaicesTools`/etc. no dependan del `browser` suelto (ya no lo reciben desde PR anterior).

- [ ] **Step 4: Correr tests + build**

Run: `npx jest tests/registroSesionesSii.test.ts && npm run build`
Expected: PASS + build limpio.

- [ ] **Step 5: Commit**

```bash
git add src/registroSesionesSii.ts src/server.ts tests/registroSesionesSii.test.ts
git commit -m "fix: Browser por RUT en registro MCP, evita cruce de sesiones (fase 0)"
```

### Task 0.5: Verificación e2e real de la fase 0

**Files:** ninguno (verificación manual).

- [ ] **Step 1: Build + suite completa con Postgres**

```bash
docker compose -f docker-compose.test.yml up -d
export TEST_DATABASE_URL="postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test"
npm run build && npm test
docker compose -f docker-compose.test.yml down
```
Expected: todo verde.

- [ ] **Step 2: Verificar cada ruta REST existente con CLAVE real (sin cert)**

Levantar el REST local apuntando a Neon, con un `.env` temporal SIN `SII_CERT_PATH` (solo `SII_CLAVE`). Con la API key del tenant de prueba, hacer `POST /v1/rcv/resumen`, `/v1/renta/estado-declaracion`, `/v1/bhe/resumen`, `/v1/dte/list-documentos-emitidos`, `/v1/mipyme/list-empresas` con `rut`+`clave` reales.
Expected: cada una devuelve `{ok:true, ...}` con datos reales — NO `{ok:false,error:'ERROR'}`. Esto confirma que la fase 0 arregló el bug de prod.

- [ ] **Step 3: PR de la fase 0**

Un PR con las tasks 0.2–0.4 (0.1 y 0.5 no dejan código). pr-review + CI + merge + deploy. Re-verificar en prod una ruta con clave real.

---

## DOMINIO 1 — Contribuyentes públicos

### Task 1.1: Scraper sin sesión + core + schemas

**Files:**
- Create: `src/scrapers/contribuyentes.ts`, `src/core/contribuyentes.ts`, `src/core/schemas/contribuyentes.ts`
- Test: `tests/scrapers/contribuyentes.test.ts`, `tests/core/contribuyentes.test.ts`
- Create fixtures: `tests/fixtures/contribuyentes-*.html` (anonimizadas, RUT 11111111-1)

**Interfaces:**
- Produces:
  - `class ContribuyentesScraper { constructor(browser: Browser); situacionTributaria(rut): Promise<SituacionTributaria>; verificarRut(rut, serie): Promise<{vigente: boolean}>; actividadesEconomicas(categoria?): Promise<Actividad[]> }`
  - core: `situacionTributaria(browser, rut)`, `verificarRut(browser, rut, serie)`, `actividadesEconomicas(browser, categoria?)` — reciben `Browser` directo (sin `EjecutorSesion`: no hay sesión).
  - schemas: `schemaSituacion = { rut }`, `schemaVerificarRut = { rut, serie }`, `schemaActividades = { categoria? }`.
  - Tipos: `SituacionTributaria` = `{ razonSocial: string|null, inicioActividades: boolean, fechaInicioActividades: string|null, autorizadoMonedaExtranjera: boolean, actividades: {codigo:number,descripcion:string,categoria:number|null,afectaIva:boolean}[], documentosTimbrados: {documento:string,anioUltimoTimbraje:number}[] }`; `Actividad` = `{codigo:number,descripcion:string,categoria:number,afectaIva:boolean,disponibleInternet:boolean}`.
- Error de negocio: RUT inexistente → lanzar `class RutInvalido extends Error {}` (nueva, en `src/erroresSesion.ts`), que `clasificarErrorCredenciales` mapea a `RUT_INVALIDO`.

- [ ] **Step 1:** Escribir tests de scraper con fixtures HTML reales anonimizadas (una por operación). Assert de los campos parseados. Ejecutar → FAIL.
- [ ] **Step 2:** Implementar `ContribuyentesScraper` navegando las páginas públicas del SII (URLs a determinar en la implementación observando el portal: situación tributaria de terceros, verificación de RUT, catálogo de actividades). Usa `Browser` con `snapshot`/`getText`. Ejecutar → PASS.
- [ ] **Step 3:** Escribir tests de core (mockeando el scraper) + implementar core. El core serializa con una `ColaPorClave` de clave fija `'contribuyentes-publico'` y un `Browser('contribuyentes-publico')` compartido (contexto nombrado persistente, no efímero) para no abrir N Chromes. Ejecutar → PASS.
- [ ] **Step 4:** Agregar `RutInvalido` a `src/erroresSesion.ts` y su mapeo en `clasificarErrorCredenciales` → `'RUT_INVALIDO'`. Test del mapeo.
- [ ] **Step 5:** Commit.

### Task 1.2: Rutas REST + tools MCP de contribuyentes

**Files:**
- Create: `src/rest/rutas/contribuyentes.ts`, `src/tools/contribuyentes.ts`
- Modify: `src/restServer.ts` (registrar), `src/server.ts` (registrar tools)
- Test: `tests/rest/rutas/contribuyentes.test.ts`, `tests/tools/contribuyentes.test.ts`

**Interfaces:**
- Consumes: core de 1.1, `ejecutar`/`RutaHandler` (`src/rest/rutas/comun.ts`), `envolverParaMcp` (`src/erroresSesion.ts`).
- Nota: estas rutas NO usan `ejecutorPassThroughDe` (no hay credencial SII). El handler llama al core con el `Browser` compartido directamente. Igual pasan por auth de tenant + rate-limit + auditoría (eso lo da `manejarRequest`, no la ruta).

- [ ] **Step 1:** Tests de ruta: `POST /v1/contribuyentes/situacion-tributaria` con `{rut}` válido → `{ok:true,...}`; RUT inexistente → `{ok:false,error:'RUT_INVALIDO'}`; body inválido → 400. Análogo verificar-rut y actividades-economicas. → FAIL.
- [ ] **Step 2:** Implementar `registrarRutasContribuyentes(rutas, browserPublico)` + registrar en `restServer.ts`. → PASS.
- [ ] **Step 3:** Tests de tools MCP + implementar `registerContribuyentesTools`. → PASS.
- [ ] **Step 4:** Build + suite completa con Postgres.
- [ ] **Step 5:** Verificación e2e real (RUT de un tercero conocido) + comparar con apigateway v1 vía script. Commit + PR + pr-review + merge + deploy.

---

## Task 2: Camino binario en SiiHttpClient

**Files:**
- Modify: `src/http.ts` (agregar `getBuffer`; el corte por `MARCA_CONTENT_TYPE` en `curl` `:204-215` ya trabaja sobre bytes)
- Test: `tests/http.getBuffer.test.ts`

**Interfaces:**
- Produces: `async getBuffer(url, params?): Promise<{ buffer: Buffer, contentType: string }>` — devuelve bytes crudos SIN pasar por `decodificarRespuesta` (que corrompe binarios). Reutiliza el mismo `curl` pero sin decodificar el cuerpo.

- [ ] **Step 1:** Test: `getBuffer` sobre una respuesta con `MARCA_CONTENT_TYPE` devuelve el `Buffer` intacto (bytes de un `%PDF` de prueba) y el `contentType`. Mockear `execFileSync`. → FAIL.
- [ ] **Step 2:** Refactor menor de `curl` para exponer el corte `{cuerpo: Buffer, contentType}` sin decodificar; `get`/`postForm`/`postSdi` siguen decodificando (sin cambio de comportamiento), `getBuffer` no. → PASS.
- [ ] **Step 3:** Helper compartido `assertPdf(buffer): void` en `src/http.ts` o `src/pdf.ts` — lanza si los primeros 4 bytes no son `%PDF`. Test. → PASS.
- [ ] **Step 4:** Build + suite. Commit + PR + pr-review + merge (sin deploy: no cambia comportamiento observable todavía).

---

## DOMINIO 3 — F29

### Task 3.1: Spike de empresa_rut + scraper F29 (consultas)

**Files:**
- Create: `src/scrapers/f29.ts`, `src/core/f29.ts`, `src/core/schemas/f29.ts`
- Test: `tests/scrapers/f29.test.ts`, `tests/core/f29.test.ts`, fixtures anonimizadas

**Interfaces:**
- Produces:
  - `class F29Scraper { constructor(http: SiiHttpClient, session: SessionManager); listDeclaraciones(periodo, empresaRut?): Promise<Declaracion[]>; detalle(folio, empresaRut?): Promise<F29Detalle>; estados(empresaRut?): Promise<Estado[]> }` (patrón renta.ts:66-70)
  - core: `listDeclaraciones(ejecutor, rut, periodo, empresaRut?)`, `detalle(ejecutor, rut, folio, empresaRut?)`, `estados(ejecutor, rut, empresaRut?)` (patrón `src/core/rcv.ts:9-20`).
  - schemas con `rut`, `empresa_rut?` + los propios.
  - Tipos: `Declaracion` = `{folio:number,estadoCodigo:string,estadoDescripcion:string,fechaPresentacion:string,totalAPagar:number|null}`; `F29Detalle` = `{folio,periodo,codigos:{codigo:string,glosa:string|null,valor:number}[]}`; `Estado` = `{folio:number,periodo:string,estadoCodigo:string,estadoDescripcion:string}`.
- Folio inexistente → `NO_ENCONTRADO` (agregar `class NoEncontrado extends Error {}` a `src/erroresSesion.ts` + mapeo). Período sin declaraciones → `{ok, declaraciones:[], sinDatos:true}`.

- [ ] **Step 1: Spike de empresa_rut** — probar contra la empresa real cómo se consulta el F29 de otra empresa: ¿va en el sobre (como RCV, `rutEmisor`) o server-side (como mipyme, `conEmpresaExclusiva`) o solo cuelga del RUT autenticado (como renta)? Registrar el mecanismo. Si solo cuelga del RUT autenticado, ELIMINAR `empresa_rut` de los schemas F29 y anotarlo.
- [ ] **Step 2:** Tests de scraper con fixtures → FAIL → implementar según el mecanismo del spike → PASS.
- [ ] **Step 3:** Tests de core + implementar. `NoEncontrado`/`sinDatos`. → PASS.
- [ ] **Step 4:** Commit.

### Task 3.2: PDFs F29 + rutas REST + tools MCP

**Files:**
- Modify: `src/scrapers/f29.ts` (métodos `certificadoSolemnePdf`/`formularioCompactoPdf` con `getBuffer`+`assertPdf`), `src/core/f29.ts`, `src/core/schemas/f29.ts`
- Create: `src/rest/rutas/f29.ts`, `src/tools/f29.ts`; Modify `src/restServer.ts`, `src/server.ts`
- Test: rutas, tools, core de PDFs

**Interfaces:**
- Produces: core `certificadoSolemne(ejecutor,rut,folio,empresaRut?)`/`formularioCompacto(...)` → `{pdfBase64, contentType:'application/pdf'}`. Rutas `POST /v1/f29/{list-declaraciones,detalle,estados,certificado-solemne,formulario-compacto}`.

- [ ] **Step 1:** Tests PDF (folio válido → base64 empieza por el b64 de `%PDF`; folio inexistente → `NO_ENCONTRADO`; SII devuelve HTML → `NO_ENCONTRADO`/`ERROR` vía `assertPdf`). → FAIL → implementar → PASS.
- [ ] **Step 2:** Rutas REST + tools MCP para las 5 operaciones. Tests. → PASS.
- [ ] **Step 3:** Build + suite. Verificación e2e real (empresa 78122544-4) + comparar apigateway. Commit + PR + pr-review + merge + deploy.

---

## DOMINIO 4 — Mipyme lectura restante

### Task 4.1: info-contribuyente, list-borradores, list-dte-recibidos

**Files:**
- Modify: `src/scrapers/mipymeHttp.ts` (métodos nuevos), `src/core/mipyme.ts`, `src/core/schemas/mipyme.ts`
- Create/Modify: `src/rest/rutas/mipyme.ts`, `src/tools/mipyme.ts`
- Test: scraper, core, rutas, tools

**Interfaces:**
- Produces (métodos sobre `MipymeHttpScraper`, todos dentro de `conEmpresaExclusiva` como `listDteEmitidos` `:380`):
  - `infoContribuyente(contribuyenteRut, tipoDte, empresaRut?)` → `{razonSocial,direccion,comuna,giro,autorizadoParaTipo}`
  - `listBorradores(filtros)` → `{documentos: (fila & {codigo:string})[], pagina, totalPaginas}`
  - `listDteRecibidos(filtros)` → mismo shape que emitidos, filtro `emisorRut?`.
- Schemas: `schemaInfoContribuyente`, `schemaListBorradores` (mismos filtros que `schemaListDteEmitidos`), `schemaListDteRecibidos`.

- [ ] Tests scraper (fixtures) → impl → tests core → impl → rutas + tools → build + suite → e2e real + comparar apigateway → commit + PR + pr-review + merge + deploy.

### Task 4.2: dte-pdf, dte-xml, borrador-pdf (binarios)

**Files:** `src/scrapers/mipymeHttp.ts`, `src/core/mipyme.ts`, `src/core/schemas/mipyme.ts`, rutas, tools, tests.

**Interfaces:**
- Produces: `dtePdf({tipoDte,folio,lado,emisorRut?})`→`{pdfBase64,contentType}`; `dteXml(...)`→`{xmlBase64,contentType:'application/xml'}`; `borradorPdf(codigo)`→`{pdfBase64,contentType}`. Usan `getBuffer`+`assertPdf` (PDF) / `getBuffer` + base64 crudo (XML, ISO-8859-1).
- Regla zod `.refine`: `emisor_rut` requerido si `lado='recibido'`, prohibido si `lado='emitido'` → `BAD_REQUEST`. `codigo`/`folio` inexistente → `NO_ENCONTRADO`.

- [ ] Tests (incluyendo las dos violaciones 400 del refine, y NO_ENCONTRADO) → impl → build + suite → e2e real + comparar apigateway → commit + PR + pr-review + merge + deploy.

---

## DOMINIO 5 — RCV async

### Task 5.1: Spike RCV async

**Files:** `src/scripts/spikeRcvAsync.ts` (throwaway).

- [ ] Probar contra la empresa real si el backend SDI de RCV expone `solicitar/estado/detalle` async por la vía de `postSdi` que ya usamos (`src/scrapers/rcv.ts` BASE/NAMESPACE). Descubrir los nombres de método SDI del async y el shape de respuesta. **Si el SII no lo expone por esta vía: documentar la limitación en la spec, cerrar el sub-proyecto sin este dominio, y saltar 5.2.** Borrar el script.

### Task 5.2: RCV async (solo si el spike 5.1 fue positivo)

**Files:** `src/scrapers/rcv.ts` (métodos async), `src/core/rcv.ts`, `src/core/schemas/rcv.ts`, `src/rest/rutas/rcv.ts`, `src/tools/rcv.ts`, tests.

**Interfaces:**
- Produces: `solicitarAsync(periodo,operacion,tipoDoc,estadoDocumentos?,empresaRut?)`→`{solicitudId:number,uuid:string,registros:number}`; `estadoAsync(...,solicitudId)`→`{estadoProcesamiento:string,creada:string,terminada:string|null}`; `detalleAsync(...,solicitudId)`→ mismo shape que `detalle`.
- Regla zod: `estado_documentos` presente con `operacion='VENTA'` → `BAD_REQUEST`.

- [ ] Tests (incluyendo la regla 400 de estado_documentos+VENTA) → impl → build + suite → e2e real + comparar apigateway → commit + PR + pr-review + merge + deploy.

---

## Cierre del sub-proyecto

- [ ] Revocar `APIGATEWAY_TOKEN` (legacy) y sacarlo del `.env`.
- [ ] Actualizar memoria del proyecto con los dominios homologados y cualquier limitación (ej. si RCV async se cayó).
- [ ] Confirmar que no quedan PRs abiertos.
