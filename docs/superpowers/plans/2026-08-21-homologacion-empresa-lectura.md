# Homologación apigateway v2 — Sub-proyecto 1 (empresa, lectura) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exponer vía REST y MCP los servicios de EMPRESA de solo lectura del catálogo apigateway.cl v2 (RCV async, F29, mipyme lectura, contribuyentes públicos), sobre la arquitectura de sesión + scraping existente.

**Architecture:** Cada dominio sigue el patrón vigente `src/core/<d>.ts` (lógica, tipada contra `EjecutorSesion`) + `src/core/schemas/<d>.ts` (schemas zod compartidos MCP/REST) + `src/tools/<d>.ts` (adaptador MCP, `envolverParaMcp`) + `src/rest/rutas/<d>.ts` (adaptador REST, `ejecutar`+`ejecutorPassThroughDe`). El scraping HTTP usa `SiiHttpClient` sobre el cookie jar de la sesión. Una fase 0 previa habilita el pass-through de CERTIFICADO en el REST (el consumidor manda el `.pfx` en base64 + password por request, como apigateway `auth.cert`), sin lo cual ninguna ruta REST autenticada funciona (el clave pass-through no es viable: queue-it + F5 WAF).

**Tech Stack:** TypeScript, Node 24, zod, jest, pg (Neon), agent-browser (Chromium), curl (vía execFileSync).

**Spec:** `docs/superpowers/specs/2026-08-21-homologacion-empresa-lectura-design.md`

## Global Constraints

- Contrato REST: `{ok:true, ...datos}` en éxito, `{ok:false, error:CODIGO}` en fallo, siempre HTTP 200 salvo `BAD_REQUEST`/`PAYLOAD_TOO_LARGE` (400/413). Rutas `POST /v1/<dominio>/<accion>`.
- Toda ruta REST autenticada recibe `rut`, `certificado_base64`, `certificado_password` y (según dominio) `empresa_rut?`, salvo el dominio `contribuyentes` (sin credencial de SII). En MCP la credencial es el certificado del proceso (`.env`), no un parámetro de la tool.
- Errores de negocio uniformes: `NO_ENCONTRADO` (folio/código inexistente), `RUT_INVALIDO` (contribuyentes), además de los vigentes `BAD_REQUEST`/`CREDENCIALES_INVALIDAS`/`ERROR`.
- PDFs/XML como `{ok, pdfBase64|xmlBase64, contentType}`; validar magic bytes `%PDF` antes de encodear.
- TDD estricto, un PR por dominio, `maxWorkers:1` en jest (infra comparte DB). Tests de infra requieren `TEST_DATABASE_URL` (Docker Postgres, `docker-compose.test.yml`, puerto 55432, `mcp_sii:mcp_sii@.../mcp_sii_test`).
- RUTs en fixtures/tests: solo de dígito repetido (11111111-1, etc.) — el test `tests/anonimizacion.test.ts` rechaza RUTs reales en archivos versionados.
- Verificación e2e real por dominio: credenciales del `.env` (persona y empresa de prueba del entorno) + comparación con apigateway v1 (`APIGATEWAY_TOKEN` en `.env`) antes de cada PR.
- Comentarios y mensajes en español, sin em-dash en nombres de recursos AWS.

---

## FASE 0 — Pass-through de certificado en el adaptador REST (prerrequisito)

El clave pass-through para consultas no es viable (spike confirmó: queue-it + F5 WAF, sin sesión reutilizable). El login por certificado sí funciona (`loginWithCert` obtiene el jar por curl TLS mutual auth). Los consumidores mandan el `.pfx` en base64 + password POR REQUEST (como apigateway `auth.cert`). Spike ya validó: `.pfx` base64 → temporal → sesión Certificate → consulta renta real OK.

Sin esta fase, las rutas REST de rcv/renta/bhe/dte/mipyme por credencial no funcionan vía REST.

### Task 0.1: `guardarCertificado` en ProveedorCredencialesRuntime

**Files:**
- Modify: `src/credencialesRuntime.ts` (nuevo método + `borrar` limpia el `.pfx`)
- Modify: `src/rutaTemporalSii.ts` (nada; ya sirve `rutaTemporalSii('pfxruntime', rut)`)
- Test: `tests/credencialesRuntime.cert.test.ts`

**Interfaces:**
- Consumes: `rutaTemporalSii` (`src/rutaTemporalSii.ts:14`), `fs`, `AuthStrategy`/`SiiConfig` (`src/env.ts`).
- Produces: `guardarCertificado(rut: string, certificadoBase64: string, certificadoPassword: string, claveCertSii?: string): void` — escribe el `.pfx` decodificado a `rutaTemporalSii('pfxruntime', rut)` y guarda un `SiiConfig` con `strategy: AuthStrategy.Certificate`, `certPath` = ese temporal, `certPassword`, `claveCertificadoSii`. `borrar(rut)` además hace `fs.unlinkSync` del `.pfx` temporal si existe.

- [ ] **Step 1: Test que falla**

```typescript
import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';
import { AuthStrategy } from '../src/env';
import * as fs from 'fs';
import { rutaTemporalSii } from '../src/rutaTemporalSii';

it('guardarCertificado escribe el pfx y arma config Certificate', async () => {
  const prov = new ProveedorCredencialesRuntime();
  const b64 = Buffer.from('contenido-pfx-fake').toString('base64');
  prov.guardarCertificado('11111111-1', b64, 'pass', 'clavecert');
  const cfg = await prov.para('11111111-1');
  expect(cfg.strategy).toBe(AuthStrategy.Certificate);
  expect(cfg.certPassword).toBe('pass');
  expect(cfg.claveCertificadoSii).toBe('clavecert');
  expect(fs.readFileSync(cfg.certPath!, 'utf-8')).toBe('contenido-pfx-fake');
});

it('borrar limpia el pfx temporal', async () => {
  const prov = new ProveedorCredencialesRuntime();
  prov.guardarCertificado('22222222-2', Buffer.from('x').toString('base64'), 'p');
  const ruta = rutaTemporalSii('pfxruntime', '22222222-2');
  expect(fs.existsSync(ruta)).toBe(true);
  prov.borrar('22222222-2');
  expect(fs.existsSync(ruta)).toBe(false);
});
```

- [ ] **Step 2: Correr, verificar falla** — `npx jest tests/credencialesRuntime.cert.test.ts` → FAIL (`guardarCertificado is not a function`).

- [ ] **Step 3: Implementar** en `src/credencialesRuntime.ts`:

```typescript
import * as fs from 'fs';
import { rutaTemporalSii } from './rutaTemporalSii';
// ...
  guardarCertificado(rut: string, certificadoBase64: string, certificadoPassword: string, claveCertSii?: string): void {
    const certPath = rutaTemporalSii('pfxruntime', rut);
    fs.writeFileSync(certPath, Buffer.from(certificadoBase64, 'base64'));
    this.porRut.set(normalizar(rut), {
      rut,
      strategy: AuthStrategy.Certificate,
      certPath,
      certPassword: certificadoPassword,
      claveCertificadoSii: claveCertSii,
    });
  }

  borrar(rut: string): void {
    const n = normalizar(rut);
    try { fs.unlinkSync(rutaTemporalSii('pfxruntime', rut)); } catch { /* no existía */ }
    this.porRut.delete(n);
  }
```

- [ ] **Step 4: Correr, verificar pasa.** **Step 5: Commit.**

### Task 0.2: `ejecutorPassThroughCertDe`

**Files:**
- Modify: `src/rest/ejecutorPassThrough.ts` (nueva función; conservar la existente)
- Test: `tests/rest/ejecutorPassThroughCert.test.ts`

**Interfaces:**
- Consumes: `RegistroSesiones.ejecutarPassThrough` (existente), `ProveedorCredencialesRuntime.guardarCertificado`/`borrar` (Task 0.1).
- Produces: `ejecutorPassThroughCertDe<T>(registro, credenciales, rut, certificadoBase64, certificadoPassword, claveCertSii?): EjecutorSesion<T>` — en `preparar` llama `guardarCertificado`, en `finalizar` `borrar` (que limpia el `.pfx`). Mismo shape que `ejecutorPassThroughDe` (`src/rest/ejecutorPassThrough.ts:11`).

- [ ] TDD: test que verifica que `preparar` invoca `guardarCertificado` con el material y `finalizar` invoca `borrar` (mock de credenciales + registro). Implementar copiando la forma de `ejecutorPassThroughDe`. Commit.

### Task 0.3: Cambiar el zod de credencial de las rutas REST existentes

**Files:**
- Modify: `src/rest/rutas/rcv.ts`, `renta.ts`, `bhe.ts`, `dte.ts`, `mipyme.ts` (el `.extend({ clave: ... })` → certificado; y `ejecutorPassThroughDe` → `ejecutorPassThroughCertDe`)
- Test: los tests de ruta existentes de esos 5 dominios

**Interfaces:**
- Consumes: `ejecutorPassThroughCertDe` (Task 0.2).
- Produces: cada ruta valida `certificado_base64: z.string().min(1)` + `certificado_password: z.string().min(1)` en vez de `clave`. El `rut` y los params propios no cambian.

- [ ] **Step 1:** Actualizar tests de ruta (rcv/renta/bhe/dte/mipyme): el body de éxito pasa `certificado_base64`/`certificado_password` en vez de `clave`; el mock de core sigue igual. Un test nuevo: body sin `certificado_base64` → `400 BAD_REQUEST`. → FAIL.
- [ ] **Step 2:** En cada `src/rest/rutas/<d>.ts`: cambiar `.extend({ clave: z.string().min(1) })` por `.extend({ certificado_base64: z.string().min(1), certificado_password: z.string().min(1) })`; desestructurar esos campos; usar `ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password)`. → PASS.
- [ ] **Step 3:** Build + suite completa con Postgres. Commit.

Nota: NO se toca `assertPuedeEntregarCookieJar` (con Certificate ya pasa), ni el modelo MCP (sigue con certificado de `.env`), ni hay carrera multi-RUT (el jar lo escribe curl, no el browser compartido).

### Task 0.4: Verificación e2e real + PR

**Files:** ninguno (verificación).

- [ ] **Step 1:** Build + suite con Postgres (`docker compose -f docker-compose.test.yml up -d`, `TEST_DATABASE_URL=...`, `npm test`, `down`). Todo verde.
- [ ] **Step 2:** Levantar el REST local contra Neon con un `.env` SIN `SII_CERT_PATH` de proceso. Convertir el `.pfx` real a base64 (`base64 -i CLCert.pfx`). Con la API key del tenant de prueba, `POST /v1/rcv/resumen` (y las otras 4 rutas existentes) con `rut` + `certificado_base64` + `certificado_password` reales. Cada una → `{ok:true, ...}` con datos reales.
- [ ] **Step 3:** PR de la fase 0 (Tasks 0.1–0.3). pr-review + CI + merge + deploy. Re-verificar una ruta en prod con el `.pfx` real.

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
- [ ] **Step 3:** Build + suite. Verificación e2e real (empresa de prueba del .env) + comparar apigateway. Commit + PR + pr-review + merge + deploy.

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
