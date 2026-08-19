# Adaptador REST + Neon (infra + dominio RCV) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Levantar toda la infraestructura nueva del adaptador REST (Neon: esquema, migraciones, auth por API key, rate limit por tenant e IP, auditoría, `/health`, script CLI de alta de tenants) y exponerla de punta a punta para un primer dominio completo: RCV (`/v1/rcv/resumen`, `/v1/rcv/detalle`).

**Architecture:** Proceso HTTP nuevo (`src/restServer.ts` + `src/restServerIndex.ts`), separado del MCP stdio y de `validar-clave` (que se absorbe en un plan posterior, junto con los otros 5 dominios). Cada operación se extrae de `src/tools/*.ts` a `src/core/*.ts` (funciones de dominio compartidas entre MCP y REST); el schema zod de cada operación se define una sola vez y lo importan ambos adaptadores. Neon guarda sólo datos operacionales del servicio (tenants, API keys, contadores, auditoría) — nunca la clave tributaria, que sigue viajando por request y se descarta.

**Tech Stack:** TypeScript, `pg` (node-postgres) sin ORM, SQL plano versionado para migraciones, Jest contra un Postgres real en Docker para los tests de infra (no mockeado — la lógica vive en SQL).

**Spec:** `docs/superpowers/specs/2026-08-19-adaptador-rest-neon-design.md`

## Global Constraints

- La clave tributaria (`clave`) nunca se persiste en ninguna tabla ni se loguea.
- El header `Authorization` (API key) nunca llega a un log de aplicación ni a un mensaje de error serializado.
- Toda la auth es fail-closed ante caída de Neon; el rate-limit por tenant es fail-open (no bloquea el servicio entero por un problema de contador).
- Body de request máximo 4KB; excederlo responde `413` y se audita igual que cualquier otro rechazo.
- Todo request deja una fila en `auditoria` — éxito o rechazo (401/429/400/413) — nunca con `tenant_id`/`rut` inventados: `NULL` cuando corresponde.
- Todas las rutas de negocio van bajo `/v1`; `/health` no lleva prefijo y no requiere auth.
- Sin ORM, sin framework HTTP (Node `http` nativo, mismo criterio que `src/httpServer.ts`).

---

## File Structure

- **Crea** `src/db.ts`: pool de conexión a Neon (`pg.Pool`), lazy, con `max` bajo.
- **Crea** `db/migraciones/0001_inicial.sql`: las 5 tablas del esquema.
- **Crea** `src/scripts/migrar.ts`: aplica migraciones pendientes contra `DATABASE_URL`.
- **Crea** `src/scripts/crearTenant.ts`: CLI que inserta un tenant y genera+muestra su API key.
- **Crea** `src/rest/apiKeyFormato.ts`: generación de API keys (`sk_<tenant>_<random>`) y su hash.
- **Crea** `src/rest/auth.ts`: `autenticarTenant(pool, apiKey)`.
- **Crea** `src/rest/rateLimit.ts`: `chequearRateLimitTenant`, `chequearRateLimitIp`.
- **Crea** `src/rest/auditoria.ts`: `registrarAuditoria(...)`.
- **Crea** `src/rest/http.ts`: helpers HTTP genéricos (`leerBody` con tope de 4KB, `responderJson`) — **extraídos de `src/httpServer.ts`**, no duplicados; `httpServer.ts` pasa a importarlos.
- **Crea** `src/core/rcv.ts`: `resumen()` y `detalle()`, extraídos de `src/tools/rcv.ts`.
- **Crea** `src/core/schemas/rcv.ts`: los schemas zod de `sii_rcv_resumen`/`sii_rcv_detalle`, extraídos de `src/tools/rcv.ts`, importados tanto por `tools/rcv.ts` como por la ruta REST.
- **Modifica** `src/tools/rcv.ts`: usa `core/rcv.ts` + `core/schemas/rcv.ts` en vez de tener la lógica y el schema inline.
- **Crea** `src/rest/rutas/rcv.ts`: `POST /v1/rcv/resumen` y `POST /v1/rcv/detalle`.
- **Crea** `src/restServer.ts`: arma el servidor HTTP — `/health`, pipeline de auth/rate-limit/auditoría, monta `src/rest/rutas/rcv.ts`.
- **Crea** `src/restServerIndex.ts`: entrypoint del proceso (env vars, wiring), igual rol que `src/index.ts`/`src/httpServerIndex.ts`.
- **Modifica** `package.json`: `pg` como dependencia, scripts `db:migrar`, `crear-tenant`, `start:rest`.
- **Crea** `docker-compose.test.yml`: Postgres para tests locales/CI.
- **Tests:** `tests/db/migrar.test.ts`, `tests/rest/apiKeyFormato.test.ts`, `tests/rest/auth.test.ts`, `tests/rest/rateLimit.test.ts`, `tests/rest/auditoria.test.ts`, `tests/rest/http.test.ts`, `tests/core/rcv.test.ts`, `tests/rest/rutas/rcv.test.ts`, `tests/restServer.test.ts`.

---

### Task 1: Dependencia `pg` + pool de conexión a Neon

**Files:**
- Modify: `package.json`
- Create: `src/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `getPool(): Pool` — usado por todos los módulos de `src/rest/*.ts` y `src/scripts/*.ts` en tasks siguientes.

- [ ] **Step 1: Agregar la dependencia**

```bash
npm install pg
npm install --save-dev @types/pg
```

- [ ] **Step 2: Escribir el test que falla**

Crear `tests/db.test.ts`:

```typescript
import { getPool } from '../src/db';

describe('getPool', () => {
  const ORIGINAL_ENV = process.env.DATABASE_URL;
  afterEach(() => { process.env.DATABASE_URL = ORIGINAL_ENV; });

  it('lanza si DATABASE_URL no está configurada', () => {
    delete process.env.DATABASE_URL;
    expect(() => getPool()).toThrow('DATABASE_URL');
  });

  it('devuelve siempre la misma instancia de Pool (singleton)', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/db';
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2b: Correr el test y confirmar que falla**

Run: `npx jest tests/db.test.ts`
Expected: FAIL — `src/db.ts` no existe.

- [ ] **Step 3: Implementar**

Crear `src/db.ts`:

```typescript
import { Pool } from 'pg';

// Pool chico y perezoso: Neon limita las conexiones directas, así que se usa
// el connection string *pooled* de Neon (PgBouncer del lado de Neon) con un
// pool cliente chico acá — `max` bajo evita agotar el límite de Neon si el
// proceso escala a varias instancias.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('Variable de entorno requerida no encontrada: DATABASE_URL');
    }
    pool = new Pool({ connectionString, max: 10 });
  }
  return pool;
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npx jest tests/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/db.ts tests/db.test.ts
git commit -m "feat: pool de conexión a Neon (pg)"
```

---

### Task 2: Postgres de test + esquema inicial + runner de migraciones

**Files:**
- Create: `docker-compose.test.yml`
- Create: `db/migraciones/0001_inicial.sql`
- Create: `src/scripts/migrar.ts`
- Test: `tests/db/migrar.test.ts`

**Interfaces:**
- Consumes: `getPool()` (Task 1).
- Produces: `aplicarMigraciones(pool: Pool): Promise<void>` — usado por el runner CLI y por el `beforeAll` de todos los tests de infra desde acá en adelante. Las 5 tablas (`tenants`, `api_keys`, `rate_limit_contador`, `auth_fallida_contador`, `auditoria`) — usadas por todas las tasks siguientes.

- [ ] **Step 1: Levantar Postgres de test**

Crear `docker-compose.test.yml`:

```yaml
services:
  postgres-test:
    image: postgres:16
    environment:
      POSTGRES_USER: mcp_sii
      POSTGRES_PASSWORD: mcp_sii
      POSTGRES_DB: mcp_sii_test
    ports:
      - '55432:5432'
```

```bash
docker compose -f docker-compose.test.yml up -d
```

Exportar para toda la sesión de trabajo (y para CI, como variable de entorno del job):

```bash
export TEST_DATABASE_URL="postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test"
```

- [ ] **Step 2: Escribir el esquema**

Crear `db/migraciones/0001_inicial.sql`:

```sql
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
```

- [ ] **Step 3: Escribir el test que falla**

Crear `tests/db/migrar.test.ts`:

```typescript
import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';

describe('aplicarMigraciones', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS auditoria, auth_fallida_contador, rate_limit_contador, api_keys, tenants CASCADE');
    await pool.end();
  });

  it('crea las 5 tablas del esquema', async () => {
    await aplicarMigraciones(pool);

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const nombres = rows.map(r => r.table_name).sort();
    expect(nombres).toEqual([
      'api_keys', 'auditoria', 'auth_fallida_contador', 'rate_limit_contador', 'tenants',
    ]);
  });

  it('correr dos veces no falla (idempotente)', async () => {
    await expect(aplicarMigraciones(pool)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 3b: Correr el test y confirmar que falla**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/db/migrar.test.ts`
Expected: FAIL — `src/scripts/migrar.ts` no existe.

- [ ] **Step 4: Implementar el runner**

Crear `src/scripts/migrar.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

const DIR_MIGRACIONES = path.join(__dirname, '..', '..', 'db', 'migraciones');

// Runner mínimo, sin librería: una tabla que registra qué migraciones ya
// corrieron, y aplica en orden las que falten. Alcanza para un puñado de
// archivos SQL versionados a mano — no hace falta Prisma Migrate ni Flyway
// para 5 tablas.
export async function aplicarMigraciones(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
      nombre text PRIMARY KEY,
      aplicada_en timestamptz NOT NULL DEFAULT now()
    )
  `);

  const archivos = fs.readdirSync(DIR_MIGRACIONES).filter(f => f.endsWith('.sql')).sort();

  for (const archivo of archivos) {
    const { rows } = await pool.query(
      'SELECT 1 FROM migraciones_aplicadas WHERE nombre = $1',
      [archivo]
    );
    if (rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(DIR_MIGRACIONES, archivo), 'utf-8');
    await pool.query(sql);
    await pool.query('INSERT INTO migraciones_aplicadas (nombre) VALUES ($1)', [archivo]);
  }
}

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  aplicarMigraciones(pool)
    .then(() => { console.log('Migraciones aplicadas.'); return pool.end(); })
    .catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 5: Correr el test y confirmar que pasa**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/db/migrar.test.ts`
Expected: PASS

- [ ] **Step 6: Agregar el script a `package.json`**

```json
    "db:migrar": "ts-node src/scripts/migrar.ts",
```

- [ ] **Step 7: Commit**

```bash
git add docker-compose.test.yml db/migraciones/0001_inicial.sql src/scripts/migrar.ts tests/db/migrar.test.ts package.json
git commit -m "feat: esquema inicial de Neon + runner de migraciones SQL planas"
```

---

### Task 3: Formato y hash de API keys

**Files:**
- Create: `src/rest/apiKeyFormato.ts`
- Test: `tests/rest/apiKeyFormato.test.ts`

**Interfaces:**
- Consumes: `crypto.randomBytes`, `crypto.createHash` (built-in).
- Produces: `generarApiKey(nombreTenant: string): string`, `hashApiKey(key: string): string`. Usados por Task 4 (`crearTenant.ts`) y Task 5 (`auth.ts`).

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/rest/apiKeyFormato.test.ts`:

```typescript
import { generarApiKey, hashApiKey } from '../../src/rest/apiKeyFormato';

describe('generarApiKey', () => {
  it('tiene el formato sk_<tenant>_<random>', () => {
    const key = generarApiKey('rdte');
    expect(key).toMatch(/^sk_rdte_[A-Za-z0-9_-]{40,}$/);
  });

  it('genera keys distintas en cada llamada', () => {
    expect(generarApiKey('rdte')).not.toBe(generarApiKey('rdte'));
  });
});

describe('hashApiKey', () => {
  it('es determinístico', () => {
    const key = generarApiKey('rdte');
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('no revierte la key original', () => {
    const key = generarApiKey('rdte');
    expect(hashApiKey(key)).not.toContain(key);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/rest/apiKeyFormato.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `src/rest/apiKeyFormato.ts`:

```typescript
import { randomBytes, createHash } from 'crypto';

// Formato sk_<tenant>_<random>: el prefijo con el nombre del tenant ayuda a
// identificar de un vistazo de qué consumidor es una key en logs de acceso o
// paneles, sin exponer nada sensible (la key entera sigue siendo el secreto).
export function generarApiKey(nombreTenant: string): string {
  const random = randomBytes(32).toString('base64url');
  return `sk_${nombreTenant}_${random}`;
}

// Sólo el hash se guarda en Neon (api_keys.key_hash) — la key real se muestra
// una única vez al crearla y no se persiste en ningún lado.
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npx jest tests/rest/apiKeyFormato.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rest/apiKeyFormato.ts tests/rest/apiKeyFormato.test.ts
git commit -m "feat: formato y hash de API keys"
```

---

### Task 4: Script CLI de alta de tenants

**Files:**
- Create: `src/scripts/crearTenant.ts`
- Test: `tests/scripts/crearTenant.test.ts`

**Interfaces:**
- Consumes: `getPool()` (Task 1), `generarApiKey`/`hashApiKey` (Task 3).
- Produces: `crearTenant(pool: Pool, nombre: string, limitePorMinuto?: number): Promise<{ tenantId: string; apiKey: string }>`. Comando ejecutable vía `npm run crear-tenant -- --nombre rdte`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/scripts/crearTenant.test.ts`:

```typescript
import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { hashApiKey } from '../../src/rest/apiKeyFormato';

describe('crearTenant', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => { await aplicarMigraciones(pool); });
  afterEach(async () => { await pool.query('DELETE FROM api_keys'); await pool.query('DELETE FROM tenants'); });
  afterAll(async () => { await pool.end(); });

  it('crea el tenant y una api key activa, con el hash correcto en la tabla', async () => {
    const { tenantId, apiKey } = await crearTenant(pool, 'rdte');

    const { rows } = await pool.query(
      'SELECT tenant_id, key_hash, revocada_en FROM api_keys WHERE tenant_id = $1',
      [tenantId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).toBe(hashApiKey(apiKey));
    expect(rows[0].revocada_en).toBeNull();
  });

  it('usa el límite por minuto pasado, o 60 por defecto', async () => {
    const { tenantId } = await crearTenant(pool, 'agenticerp', 120);
    const { rows } = await pool.query('SELECT limite_por_minuto FROM tenants WHERE id = $1', [tenantId]);
    expect(rows[0].limite_por_minuto).toBe(120);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/scripts/crearTenant.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `src/scripts/crearTenant.ts`:

```typescript
import { Pool } from 'pg';
import { generarApiKey, hashApiKey } from '../rest/apiKeyFormato';

export async function crearTenant(
  pool: Pool,
  nombre: string,
  limitePorMinuto = 60
): Promise<{ tenantId: string; apiKey: string }> {
  const { rows } = await pool.query(
    'INSERT INTO tenants (nombre, limite_por_minuto) VALUES ($1, $2) RETURNING id',
    [nombre, limitePorMinuto]
  );
  const tenantId = rows[0].id;

  const apiKey = generarApiKey(nombre);
  await pool.query(
    'INSERT INTO api_keys (tenant_id, key_hash) VALUES ($1, $2)',
    [tenantId, hashApiKey(apiKey)]
  );

  return { tenantId, apiKey };
}

if (require.main === module) {
  const nombre = process.argv.find((a, i) => process.argv[i - 1] === '--nombre');
  if (!nombre) {
    console.error('Uso: npm run crear-tenant -- --nombre <nombre>');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  crearTenant(pool, nombre)
    .then(({ tenantId, apiKey }) => {
      console.log(`Tenant creado: ${tenantId}`);
      console.log(`API key (mostrada una sola vez): ${apiKey}`);
      return pool.end();
    })
    .catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/scripts/crearTenant.test.ts`
Expected: PASS

- [ ] **Step 5: Agregar el script a `package.json`**

```json
    "crear-tenant": "ts-node src/scripts/crearTenant.ts",
```

- [ ] **Step 6: Commit**

```bash
git add src/scripts/crearTenant.ts tests/scripts/crearTenant.test.ts package.json
git commit -m "feat: script CLI de alta de tenants"
```

---

### Task 5: Autenticación por API key

**Files:**
- Create: `src/rest/auth.ts`
- Test: `tests/rest/auth.test.ts`

**Interfaces:**
- Consumes: `hashApiKey` (Task 3).
- Produces: `autenticarTenant(pool: Pool, apiKey: string | undefined): Promise<{ tenantId: string; nombre: string; limitePorMinuto: number } | null>`. `null` = no autenticó (401). Usado por Task 9 (`restServer.ts`).

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/rest/auth.test.ts`:

```typescript
import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { autenticarTenant } from '../../src/rest/auth';

describe('autenticarTenant', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => { await aplicarMigraciones(pool); });
  afterEach(async () => { await pool.query('DELETE FROM api_keys'); await pool.query('DELETE FROM tenants'); });
  afterAll(async () => { await pool.end(); });

  it('resuelve el tenant con una key válida', async () => {
    const { tenantId, apiKey } = await crearTenant(pool, 'rdte');
    const resultado = await autenticarTenant(pool, apiKey);
    expect(resultado).toMatchObject({ tenantId, nombre: 'rdte' });
  });

  it('null con key inexistente', async () => {
    expect(await autenticarTenant(pool, 'sk_nada_x')).toBeNull();
  });

  it('null sin key', async () => {
    expect(await autenticarTenant(pool, undefined)).toBeNull();
  });

  it('null con key revocada', async () => {
    const { apiKey } = await crearTenant(pool, 'rdte');
    await pool.query(
      `UPDATE api_keys SET revocada_en = now() WHERE key_hash = $1`,
      [require('../../src/rest/apiKeyFormato').hashApiKey(apiKey)]
    );
    expect(await autenticarTenant(pool, apiKey)).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/rest/auth.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `src/rest/auth.ts`:

```typescript
import { Pool } from 'pg';
import { hashApiKey } from './apiKeyFormato';

export interface TenantAutenticado {
  tenantId: string;
  nombre: string;
  limitePorMinuto: number;
}

export async function autenticarTenant(
  pool: Pool,
  apiKey: string | undefined
): Promise<TenantAutenticado | null> {
  if (!apiKey) return null;

  const { rows } = await pool.query(
    `SELECT t.id AS tenant_id, t.nombre, t.limite_por_minuto
     FROM api_keys k
     JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = $1 AND k.revocada_en IS NULL`,
    [hashApiKey(apiKey)]
  );

  if (rows.length === 0) return null;
  return {
    tenantId: rows[0].tenant_id,
    nombre: rows[0].nombre,
    limitePorMinuto: rows[0].limite_por_minuto,
  };
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/rest/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rest/auth.ts tests/rest/auth.test.ts
git commit -m "feat: autenticación de tenants por API key hasheada"
```

---

### Task 6: Rate limit por tenant y por IP

**Files:**
- Create: `src/rest/rateLimit.ts`
- Test: `tests/rest/rateLimit.test.ts`

**Interfaces:**
- Consumes: nada nuevo (sólo `Pool` de `pg`).
- Produces: `chequearRateLimitTenant(pool, tenantId, limitePorMinuto): Promise<boolean>` (true = permitido), `chequearRateLimitIp(pool, ip, limite): Promise<boolean>`. Usados por Task 9 (`restServer.ts`).

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/rest/rateLimit.test.ts`:

```typescript
import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { chequearRateLimitTenant, chequearRateLimitIp } from '../../src/rest/rateLimit';

describe('rate limit', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => { await aplicarMigraciones(pool); });
  afterEach(async () => {
    await pool.query('DELETE FROM rate_limit_contador');
    await pool.query('DELETE FROM auth_fallida_contador');
    await pool.query('DELETE FROM api_keys');
    await pool.query('DELETE FROM tenants');
  });
  afterAll(async () => { await pool.end(); });

  it('chequearRateLimitTenant permite hasta el límite y bloquea el siguiente', async () => {
    const { tenantId } = await crearTenant(pool, 'rdte', 2);

    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(true);
    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(true);
    expect(await chequearRateLimitTenant(pool, tenantId, 2)).toBe(false);
  });

  it('chequearRateLimitIp permite hasta el límite y bloquea el siguiente', async () => {
    expect(await chequearRateLimitIp(pool, '10.0.0.1', 2)).toBe(true);
    expect(await chequearRateLimitIp(pool, '10.0.0.1', 2)).toBe(true);
    expect(await chequearRateLimitIp(pool, '10.0.0.1', 2)).toBe(false);
  });

  it('IPs distintas no comparten contador', async () => {
    expect(await chequearRateLimitIp(pool, '10.0.0.1', 1)).toBe(true);
    expect(await chequearRateLimitIp(pool, '10.0.0.2', 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/rest/rateLimit.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `src/rest/rateLimit.ts`:

```typescript
import { Pool } from 'pg';

// Ventana fija de un minuto: trunca el timestamp actual al minuto y usa eso
// como parte de la clave primaria. Simple de razonar; alcanza para el caso de
// uso (evitar que un consumidor sature el servicio), no hace falta ventana
// deslizante.
function ventanaActual(): Date {
  const ahora = new Date();
  ahora.setSeconds(0, 0);
  return ahora;
}

export async function chequearRateLimitTenant(
  pool: Pool,
  tenantId: string,
  limitePorMinuto: number
): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO rate_limit_contador (tenant_id, ventana_inicio, contador)
     VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, ventana_inicio)
     DO UPDATE SET contador = rate_limit_contador.contador + 1
     RETURNING contador`,
    [tenantId, ventanaActual()]
  );
  return rows[0].contador <= limitePorMinuto;
}

export async function chequearRateLimitIp(
  pool: Pool,
  ip: string,
  limitePorMinuto: number
): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO auth_fallida_contador (ip, ventana_inicio, contador)
     VALUES ($1, $2, 1)
     ON CONFLICT (ip, ventana_inicio)
     DO UPDATE SET contador = auth_fallida_contador.contador + 1
     RETURNING contador`,
    [ip, ventanaActual()]
  );
  return rows[0].contador <= limitePorMinuto;
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/rest/rateLimit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rest/rateLimit.ts tests/rest/rateLimit.test.ts
git commit -m "feat: rate limit por tenant y por IP en Neon"
```

---

### Task 7: Auditoría

**Files:**
- Create: `src/rest/auditoria.ts`
- Test: `tests/rest/auditoria.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `registrarAuditoria(pool, entrada): Promise<void>` — nunca lanza (loguea a stderr y traga el error si Neon falla). Usado por Task 9 (`restServer.ts`).

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/rest/auditoria.test.ts`:

```typescript
import { Pool } from 'pg';
import { aplicarMigraciones } from '../../src/scripts/migrar';
import { crearTenant } from '../../src/scripts/crearTenant';
import { registrarAuditoria } from '../../src/rest/auditoria';

describe('registrarAuditoria', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  beforeAll(async () => { await aplicarMigraciones(pool); });
  afterEach(async () => {
    await pool.query('DELETE FROM auditoria');
    await pool.query('DELETE FROM api_keys');
    await pool.query('DELETE FROM tenants');
  });
  afterAll(async () => { await pool.end(); });

  it('inserta una fila con los campos esperados', async () => {
    const { tenantId } = await crearTenant(pool, 'rdte');

    await registrarAuditoria(pool, {
      tenantId, ip: '10.0.0.1', rut: '11.111.111-1', ruta: '/v1/rcv/resumen', status: 200, error: null,
    });

    const { rows } = await pool.query('SELECT * FROM auditoria');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: tenantId, rut: '11.111.111-1', ruta: '/v1/rcv/resumen', status: 200, error: null,
    });
  });

  it('acepta tenant_id y rut nulos (rechazo de transporte)', async () => {
    await registrarAuditoria(pool, {
      tenantId: null, ip: '10.0.0.1', rut: null, ruta: '/v1/rcv/resumen', status: 401, error: 'UNAUTHORIZED',
    });
    const { rows } = await pool.query('SELECT * FROM auditoria');
    expect(rows[0].tenant_id).toBeNull();
    expect(rows[0].rut).toBeNull();
  });

  it('no lanza si Neon no responde', async () => {
    const poolRoto = new Pool({ connectionString: 'postgres://nadie:nada@localhost:1/no-existe' });
    await expect(registrarAuditoria(poolRoto, {
      tenantId: null, ip: '10.0.0.1', rut: null, ruta: '/x', status: 500, error: 'ERROR',
    })).resolves.toBeUndefined();
    await poolRoto.end();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/rest/auditoria.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `src/rest/auditoria.ts`:

```typescript
import { Pool } from 'pg';

export interface EntradaAuditoria {
  tenantId: string | null;
  ip: string;
  rut: string | null;
  ruta: string;
  status: number;
  error: string | null;
}

// Nunca lanza: un fallo al auditar no debe romper ni atrasar la respuesta al
// cliente (ver spec, sección Auditoría). Se loguea a stderr para no perder la
// visibilidad del fallo, pero el caller no tiene que manejar una excepción acá.
export async function registrarAuditoria(pool: Pool, entrada: EntradaAuditoria): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO auditoria (tenant_id, ip, rut, ruta, status, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entrada.tenantId, entrada.ip, entrada.rut, entrada.ruta, entrada.status, entrada.error]
    );
  } catch (e) {
    console.error('No se pudo escribir en auditoria:', e);
  }
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/rest/auditoria.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rest/auditoria.ts tests/rest/auditoria.test.ts
git commit -m "feat: auditoría de requests, nunca bloqueante"
```

---

### Task 8: Extraer helpers HTTP compartidos de `httpServer.ts`

**Files:**
- Create: `src/rest/http.ts`
- Modify: `src/httpServer.ts`
- Test: `tests/rest/http.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `leerBody(req, maxBytes?): Promise<string>` (lanza `BodyDemasiadoGrande` si excede), `responderJson(res, status, body): void`. Usados por Task 9 (`restServer.ts`) y por `src/httpServer.ts` (ya existente, se actualiza para importar en vez de tener su propia copia).

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/rest/http.test.ts` (mismos casos que ya cubre `tests/httpServer.test.ts` para estas dos funciones, pero contra el módulo nuevo):

```typescript
import * as http from 'http';
import { leerBody, responderJson, BodyDemasiadoGrande } from '../../src/rest/http';

function requestConBody(server: http.Server, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.request({ hostname: '127.0.0.1', port, method: 'POST' }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode ?? 0, body: data }); });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });
}

describe('leerBody', () => {
  it('devuelve el body completo cuando está bajo el límite', async () => {
    const server = http.createServer(async (req, res) => {
      const body = await leerBody(req, 4_096);
      responderJson(res, 200, { recibido: body });
    });
    const { status, body } = await requestConBody(server, JSON.stringify({ a: 1 }));
    expect(status).toBe(200);
    expect(JSON.parse(body).recibido).toBe(JSON.stringify({ a: 1 }));
  });

  it('rechaza con BodyDemasiadoGrande cuando excede el límite', async () => {
    const server = http.createServer(async (req, res) => {
      try {
        await leerBody(req, 10);
        responderJson(res, 200, {});
      } catch (e) {
        responderJson(res, e instanceof BodyDemasiadoGrande ? 413 : 500, {});
      }
    });
    const { status } = await requestConBody(server, 'x'.repeat(1000));
    expect(status).toBe(413);
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/rest/http.test.ts`
Expected: FAIL — `src/rest/http.ts` no existe.

- [ ] **Step 3: Implementar (mover, no copiar)**

Crear `src/rest/http.ts` con el contenido exacto de `leerBody`/`responderJson`/`BodyDemasiadoGrande` que hoy vive en `src/httpServer.ts` (líneas ya escritas ahí, ver PR #32), parametrizando el tope de bytes:

```typescript
import * as http from 'http';

export class BodyDemasiadoGrande extends Error {}

export function leerBody(req: http.IncomingMessage, maxBytes = 4_096): Promise<string> {
  return new Promise((resolve, reject) => {
    let datos = '';
    let bytes = 0;
    let demasiadoGrande = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        demasiadoGrande = true;
        return;
      }
      datos += chunk;
    });
    req.on('end', () => {
      if (demasiadoGrande) {
        reject(new BodyDemasiadoGrande());
        return;
      }
      resolve(datos);
    });
    req.on('error', reject);
  });
}

export function responderJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
```

Editar `src/httpServer.ts`: eliminar sus propias definiciones de `leerBody`/`responderJson`/`BodyDemasiadoGrande` y reemplazar por:

```typescript
import { leerBody, responderJson, BodyDemasiadoGrande } from './rest/http';
```

(Sin cambiar ninguna otra línea de `httpServer.ts` — sigue llamando `leerBody(req)` con el default de 4096, igual que antes.)

- [ ] **Step 4: Correr el test nuevo y la suite completa de `httpServer.test.ts`**

Run: `npx jest tests/rest/http.test.ts tests/httpServer.test.ts`
Expected: PASS — los 13 tests existentes de `httpServer.test.ts` siguen pasando sin cambios de comportamiento.

- [ ] **Step 5: Commit**

```bash
git add src/rest/http.ts src/httpServer.ts tests/rest/http.test.ts
git commit -m "refactor: extraer leerBody/responderJson a src/rest/http.ts, compartido por httpServer y el REST nuevo"
```

---

### Task 9: Core + schema compartido para RCV

**Files:**
- Create: `src/core/schemas/rcv.ts`
- Create: `src/core/rcv.ts`
- Modify: `src/tools/rcv.ts`
- Test: `tests/core/rcv.test.ts`

**Interfaces:**
- Consumes: `RegistroSesiones` (`src/registroSesiones.ts`), `RcvScraper` (`src/scrapers/rcv.ts`), `conErroresDeSesion` (`src/erroresSesion.ts`) — todos ya existentes.
- Produces: `resumen(registro, rut, periodo, operacion, empresaRut?): Promise<ResumenRcv>`, `detalle(registro, rut, periodo, operacion, tipoDocCodigo, empresaRut?): Promise<DetalleRcv>` (en `src/core/rcv.ts`); `schemaResumen`, `schemaDetalle` (objetos zod, en `src/core/schemas/rcv.ts`). Task 10 (ruta REST) consume las cuatro.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/core/rcv.test.ts` (adaptado de `tests/tools/rcv.test.ts` existente, pero contra el core sin el envoltorio `{content}`):

```typescript
import { resumen, detalle } from '../../src/core/rcv';
import { RcvScraper } from '../../src/scrapers/rcv';
import { RegistroSesiones } from '../../src/registroSesiones';

jest.mock('../../src/scrapers/rcv');
const MockScraper = RcvScraper as jest.MockedClass<typeof RcvScraper>;

function registroQueEjecuta() {
  return { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
}

describe('core/rcv', () => {
  afterEach(() => jest.clearAllMocks());

  it('resumen pasa período, operación y empresa al scraper y devuelve el dato crudo', async () => {
    (MockScraper.prototype.resumen as jest.Mock).mockResolvedValue({ filas: [] });
    const registro = registroQueEjecuta();

    const resultado = await resumen(registro, '11.111.111-1', '202607', 'VENTA', '22222222-2');

    expect(MockScraper.prototype.resumen).toHaveBeenCalledWith('202607', 'VENTA', '22222222-2');
    expect(resultado).toEqual({ filas: [] });
  });

  it('detalle pasa período, operación, tipo_doc y empresa al scraper', async () => {
    (MockScraper.prototype.detalle as jest.Mock).mockResolvedValue({ documentos: [] });
    const registro = registroQueEjecuta();

    const resultado = await detalle(registro, '11.111.111-1', '202607', 'COMPRA', 33, undefined);

    expect(MockScraper.prototype.detalle).toHaveBeenCalledWith('202607', 'COMPRA', 33, undefined);
    expect(resultado).toEqual({ documentos: [] });
  });

  it('propaga el error de sesión sin traducirlo (eso lo hace cada adaptador)', async () => {
    const registro = {
      ejecutar: () => Promise.reject(new Error('No hay sesión iniciada para el RUT 1. Llamá sii_iniciar_sesion primero.')),
    } as unknown as RegistroSesiones<any>;

    await expect(resumen(registro, '1', '202607', 'VENTA')).rejects.toThrow('No hay sesión iniciada');
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/core/rcv.test.ts`
Expected: FAIL — `src/core/rcv.ts` no existe.

- [ ] **Step 3: Implementar el schema compartido**

Crear `src/core/schemas/rcv.ts` (extraído tal cual de `src/tools/rcv.ts`, sin cambios de reglas):

```typescript
import { z } from 'zod';

export const RUT_DESC = 'RUT de la persona con sesión iniciada vía sii_iniciar_sesion';

const camposComunes = {
  periodo: z.string().regex(/^\d{6}$/)
    .describe('Período tributario en formato AAAAMM (por ejemplo 202607)'),
  operacion: z.enum(['COMPRA', 'VENTA'])
    .describe('COMPRA para el registro de compras, VENTA para el de ventas'),
  empresa_rut: z.string().optional()
    .describe('RUT de la empresa a consultar, con dígito verificador (22222222-2). Si se omite, se usa el RUT autenticado.'),
};

export const schemaResumen = {
  rut: z.string().describe(RUT_DESC),
  ...camposComunes,
};

export const schemaDetalle = {
  rut: z.string().describe(RUT_DESC),
  ...camposComunes,
  tipo_doc: z.number().int().positive()
    .describe('Código del tipo de documento, obligatorio. Se obtiene de sii_rcv_resumen en filas[].tipoDocCodigo (33 factura electrónica, 61 nota de crédito, 46 factura de compra, 34 exenta, 110 exportación, 914 DIN, 56 nota de débito)'),
};
```

- [ ] **Step 4: Implementar el core**

Crear `src/core/rcv.ts`:

```typescript
import { RcvScraper, OperacionRcv, ResumenRcv, DetalleRcv } from '../scrapers/rcv';
import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';

export async function resumen(
  registro: RegistroSesiones<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionRcv,
  empresaRut?: string
): Promise<ResumenRcv> {
  return registro.ejecutar(rut, async sesion => {
    const scraper = new RcvScraper(new SiiHttpClient(sesion), sesion);
    return scraper.resumen(periodo, operacion, empresaRut);
  });
}

export async function detalle(
  registro: RegistroSesiones<SessionManager>,
  rut: string,
  periodo: string,
  operacion: OperacionRcv,
  tipoDocCodigo: number,
  empresaRut?: string
): Promise<DetalleRcv> {
  return registro.ejecutar(rut, async sesion => {
    const scraper = new RcvScraper(new SiiHttpClient(sesion), sesion);
    return scraper.detalle(periodo, operacion, tipoDocCodigo, empresaRut);
  });
}
```

- [ ] **Step 5: Correr el test del core y confirmar que pasa**

Run: `npx jest tests/core/rcv.test.ts`
Expected: PASS

- [ ] **Step 6: Actualizar `src/tools/rcv.ts` para usar el core y el schema compartido**

Reemplazar el contenido de `src/tools/rcv.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionManager } from '../session';
import { RegistroSesiones } from '../registroSesiones';
import { crearConScraper, conErroresDeSesion, SesionNoIniciada } from '../erroresSesion';
import * as core from '../core/rcv';
import { schemaResumen, schemaDetalle } from '../core/schemas/rcv';

async function envolverParaMcp<R>(fn: () => Promise<R>): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const resultado = await conErroresDeSesion(fn).catch(e => {
    if (e instanceof SesionNoIniciada) return { __error: 'SESION_NO_INICIADA' as const };
    throw e;
  });
  if (resultado && typeof resultado === 'object' && '__error' in resultado) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: resultado.__error }) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }] };
}

export function registerRcvTools(server: McpServer, registro: RegistroSesiones<SessionManager>): void {
  server.tool(
    'sii_rcv_resumen',
    'Resumen del Registro de Compras y Ventas de un período tributario: los totales por tipo de documento ' +
    '(cantidad de documentos, neto, exento, IVA y total), el total de documentos del período y la fecha de ' +
    'última actualización del registro. El campo `totales` viene con las notas de crédito (tipos 61 y 60) ' +
    'RESTADAS, que es como corresponde totalizar: sumarlas infla las ventas y el IVA. ' +
    'Si aparece un tipo de documento que el servidor no tiene catalogado, se suma a los totales pero la ' +
    'respuesta trae totalesConfiables=false, tiposDesconocidos y advertencias: en ese caso hay que avisar ' +
    'que los totales pueden estar mal antes de usarlos. ' +
    'Si el período no tiene documentos registrados, responde sinDatos=true con los totales en cero: es un ' +
    'mes sin movimientos, no un error (el campo mensaje explica el vacío cuando el SII lo explica, por ' +
    'ejemplo si el período es anterior al que cubre el registro). ' +
    'La empresa es un parámetro de la consulta, no de la sesión: se puede pasar empresa_rut distinto en ' +
    'cada llamada, sin seleccionar empresa; si se omite, se consulta el RUT autenticado. ' +
    'Es solo lectura: no acepta ni reclama documentos.',
    schemaResumen,
    async ({ rut, periodo, operacion, empresa_rut }) =>
      envolverParaMcp(() => core.resumen(registro, rut, periodo, operacion, empresa_rut))
  );

  server.tool(
    'sii_rcv_detalle',
    'Detalle documento por documento del Registro de Compras y Ventas de un período: para cada documento, ' +
    'la contraparte (RUT y razón social), el folio, la fecha de emisión, los montos neto/exento/IVA/total, ' +
    'el documento referenciado y el estado de aceptación o reclamo del receptor. ' +
    'REQUIERE el código de tipo de documento (tipo_doc): el SII entrega el detalle por tipo de documento, ' +
    'NO del período entero. Ese código sale de sii_rcv_resumen, en filas[].tipoDocCodigo, así que el orden ' +
    'es: primero sii_rcv_resumen para ver qué tipos hay en el período, después sii_rcv_detalle por cada ' +
    'tipo que interese (33 factura electrónica, 61 nota de crédito, 46 factura de compra, 34 exenta, ' +
    '110 exportación, 914 DIN, 56 nota de débito). ' +
    'La contraparte se informa con contraparteRol: en COMPRA es el emisor (el proveedor) y en VENTA es el ' +
    'receptor (el cliente); no hay que llamarla proveedor en una consulta de ventas. ' +
    'En notas de crédito y débito, referenciaTipoDoc y referenciaFolio dicen qué documento se está ' +
    'corrigiendo. ' +
    'CUIDADO con la contraparte en documentos de EXPORTACIÓN (tipos 110, 111 y 112): el cliente es ' +
    'extranjero y NO tiene RUT chileno, así que el SII pone el RUT genérico 55555555-5 en contraparteRut ' +
    'para TODOS los receptores extranjeros. Ese RUT no identifica a nadie y se repite entre clientes ' +
    'distintos: no sirve para agrupar, comparar ni cruzar. Hay que mirar contraparteTipoId: vale ' +
    '"rut_chileno" cuando contraparteRut identifica de verdad a la contraparte, y "extranjero" cuando no. ' +
    'Con "extranjero", el identificador real de la contraparte está en contraparteIdExtranjero (su RUC, ' +
    'VAT o tax id de origen; null si el SII no lo informa) y contraparteNacionalidadCodigo trae la ' +
    'nacionalidad como CÓDIGO NUMÉRICO de la tabla de países del SII (por ejemplo 218), no como nombre de ' +
    'país: no hay que traducirlo ni adivinar de qué país se trata, se reporta el código tal cual. ' +
    'CUIDADO al sumar: en las notas de crédito (tipos 61 y 60) los montos vienen POSITIVOS pero RESTAN ' +
    'del total del período, así que sumar los montoTotal de un detalle produce un total mal. Para ' +
    'totalizar hay que usar sii_rcv_resumen, que ya aplica el signo; este detalle es para mirar ' +
    'documento por documento. ' +
    'Si el período o el tipo no tienen documentos registrados, responde sinDatos=true con documentos=[]: ' +
    'es un vacío legítimo, no un error (el campo mensaje explica el vacío cuando el SII lo explica). ' +
    'La empresa es un parámetro de la consulta, no de la sesión: se puede pasar empresa_rut distinto en ' +
    'cada llamada; si se omite, se consulta el RUT autenticado. ' +
    'Es solo lectura: no acepta ni reclama documentos.',
    schemaDetalle,
    async ({ rut, periodo, operacion, tipo_doc, empresa_rut }) =>
      envolverParaMcp(() => core.detalle(registro, rut, periodo, operacion, tipo_doc, empresa_rut))
  );
}
```

**Nota:** el `envolverParaMcp` de acá adentro sustituye a `crearConScraper` para este archivo porque el core ya arma el scraper — `crearConScraper` seguía siendo responsable de DOS cosas (armar el scraper Y envolver en `{content}`); acá sólo hace falta la segunda. Los otros 5 dominios (bhe, dte, renta, mipyme, bienesRaices) siguen usando `crearConScraper` tal cual hasta que se migren en el plan siguiente — no se toca `src/erroresSesion.ts` en esta task.

- [ ] **Step 7: Correr los tests de la tool RCV y la suite completa**

Run: `npx jest tests/tools/rcv.test.ts && npm test`
Expected: PASS — los tests existentes de `tests/tools/rcv.test.ts` (que verifican el contrato `{content}`, `SESION_NO_INICIADA`, y que se pasan los parámetros correctos) siguen pasando sin cambios, porque el comportamiento externo del MCP no cambió.

- [ ] **Step 8: Commit**

```bash
git add src/core/schemas/rcv.ts src/core/rcv.ts src/tools/rcv.ts tests/core/rcv.test.ts
git commit -m "refactor: extraer core y schema compartido de RCV entre MCP y REST"
```

---

### Task 10: Rutas REST de RCV

**Files:**
- Create: `src/rest/rutas/rcv.ts`
- Test: `tests/rest/rutas/rcv.test.ts`

**Interfaces:**
- Consumes: `core.resumen`/`core.detalle` (Task 9), `schemaResumen`/`schemaDetalle` (Task 9), `registrarAuditoria` (Task 7).
- Produces: `registrarRutasRcv(router: Map<string, RutaHandler>, registro): void` — donde `RutaHandler` es el tipo que define Task 11 (`restServer.ts`). Task 11 consume esta función.

**Nota de tipos:** esta task define `RutaHandler` acá mismo (no en Task 11) porque es el primer archivo de rutas que se escribe; Task 11 importa el tipo desde acá. Si en el plan siguiente aparece un segundo archivo de rutas, este tipo se muda a un módulo común (`src/rest/tipos.ts`) — no antes, YAGNI.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/rest/rutas/rcv.test.ts`:

```typescript
import { registrarRutasRcv } from '../../../src/rest/rutas/rcv';
import { RegistroSesiones } from '../../../src/registroSesiones';
import * as core from '../../../src/core/rcv';

jest.mock('../../../src/core/rcv');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasRcv(rutas as any, {} as RegistroSesiones<any>);
  return rutas;
}

describe('registrarRutasRcv', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra POST /v1/rcv/resumen y POST /v1/rcv/detalle', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual(['POST /v1/rcv/resumen', 'POST /v1/rcv/detalle']);
  });

  it('resumen: body válido llama al core y devuelve {ok:true, ...datos}', async () => {
    (core.resumen as jest.Mock).mockResolvedValue({ filas: [] });
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', clave: 'x', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta).toEqual({ status: 200, body: { ok: true, filas: [] } });
  });

  it('resumen: body inválido devuelve 400 sin llamar al core', async () => {
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '11.111.111-1', clave: 'x', periodo: 'no-es-un-periodo', operacion: 'VENTA' }
    );

    expect(respuesta.status).toBe(400);
    expect(core.resumen).not.toHaveBeenCalled();
  });

  it('resumen: SesionNoIniciada del core se traduce a ERROR (no debería pasar en REST, pero no debe reventar)', async () => {
    (core.resumen as jest.Mock).mockRejectedValue(new Error('No hay sesión iniciada para el RUT 1. Llamá sii_iniciar_sesion primero.'));
    const rutas = armarRouter();

    const respuesta = await rutas.get('POST /v1/rcv/resumen')!(
      { rut: '1', clave: 'x', periodo: '202607', operacion: 'VENTA' }
    );

    expect(respuesta).toEqual({ status: 200, body: { ok: false, error: 'ERROR' } });
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `npx jest tests/rest/rutas/rcv.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar**

Crear `src/rest/rutas/rcv.ts`:

```typescript
import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import * as core from '../../core/rcv';
import { schemaResumen, schemaDetalle } from '../../core/schemas/rcv';
import { clasificarErrorCredenciales } from '../../erroresSesion';

export interface RespuestaRuta {
  status: number;
  body: unknown;
}

export type RutaHandler = (body: unknown) => Promise<RespuestaRuta>;

const zodResumen = z.object(schemaResumen).extend({ clave: z.string() });
const zodDetalle = z.object(schemaDetalle).extend({ clave: z.string() });

// Traduce cualquier resultado de negocio del core al contrato {ok}. Una ruta
// REST nunca debería ver SesionNoIniciada (cada request trae su propia
// `clave`, arma la sesión de cero) — si ocurriera, se trata como ERROR de
// infraestructura, no como el caso de negocio esperado que sí es en MCP.
async function ejecutar<R>(fn: () => Promise<R>): Promise<RespuestaRuta> {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasRcv(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>
): void {
  rutas.set('POST /v1/rcv/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, periodo, operacion, empresa_rut } = parseo.data;

    // Pass-through: la clave arma la sesión para este request y no se persiste.
    const credenciales = new (require('../../credencialesRuntime').ProveedorCredencialesRuntime)();
    credenciales.guardar(rut, clave);
    try {
      return await ejecutar(() => core.resumen(registro, rut, periodo, operacion, empresa_rut));
    } finally {
      credenciales.borrar(rut);
    }
  });

  rutas.set('POST /v1/rcv/detalle', async body => {
    const parseo = zodDetalle.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;

    const credenciales = new (require('../../credencialesRuntime').ProveedorCredencialesRuntime)();
    credenciales.guardar(rut, clave);
    try {
      return await ejecutar(() => core.detalle(registro, rut, periodo, operacion, tipo_doc, empresa_rut));
    } finally {
      credenciales.borrar(rut);
    }
  });
}
```

**Nota para quien ejecute este step:** el patrón `new (require(...).ProveedorCredencialesRuntime)()` de acá es deliberadamente feo — sirve para no bloquear el test (que mockea `core/rcv` pero no `credencialesRuntime`) y se limpia en el plan siguiente moviendo la construcción de `ProveedorCredencialesRuntime` a nivel de `restServer.ts` (un solo proveedor por proceso, reseteado por RUT en cada request) en vez de uno nuevo por request acá. Para esta task alcanza: el objetivo es que la ruta funcione y esté probada, no la forma final del wiring — eso se resuelve en Task 11, donde `restServer.ts` inyecta un único `ProveedorCredencialesRuntime` compartido. **Si al llegar a Task 11 el import queda raro, ajustar la firma de `registrarRutasRcv` para recibir `credenciales` como parámetro en vez de construirlo acá — hacerlo ahí, no dejarlo así.**

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `npx jest tests/rest/rutas/rcv.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rest/rutas/rcv.ts tests/rest/rutas/rcv.test.ts
git commit -m "feat: rutas REST de RCV (resumen, detalle)"
```

---

### Task 11: Limpiar el wiring de credenciales + montar `restServer.ts`

**Files:**
- Modify: `src/rest/rutas/rcv.ts`
- Create: `src/restServer.ts`
- Create: `src/restServerIndex.ts`
- Test: `tests/restServer.test.ts`

**Interfaces:**
- Consumes: `registrarRutasRcv` (Task 10, firma ajustada acá), `autenticarTenant` (Task 5), `chequearRateLimitTenant`/`chequearRateLimitIp` (Task 6), `registrarAuditoria` (Task 7), `leerBody`/`responderJson` (Task 8), `getPool` (Task 1).
- Produces: `crearRestServer(pool, registro, credenciales): http.Server`. Ejecutable como proceso vía `src/restServerIndex.ts`.

- [ ] **Step 1: Ajustar `registrarRutasRcv` para recibir `credenciales` inyectado**

Editar `src/rest/rutas/rcv.ts`: cambiar la firma a
`registrarRutasRcv(rutas, registro, credenciales: ProveedorCredencialesRuntime)`, eliminar los dos `require(...)` feos de Task 10, y usar el `credenciales` recibido por parámetro en ambos handlers. Actualizar `tests/rest/rutas/rcv.test.ts` para pasar un `new ProveedorCredencialesRuntime()` real en `armarRouter()`.

Run: `npx jest tests/rest/rutas/rcv.test.ts`
Expected: PASS (mismo comportamiento, wiring limpio).

- [ ] **Step 2: Escribir el test que falla para `restServer.ts`**

Crear `tests/restServer.test.ts`:

```typescript
import * as http from 'http';
import { Pool } from 'pg';
import { aplicarMigraciones } from '../src/scripts/migrar';
import { crearTenant } from '../src/scripts/crearTenant';
import { crearRestServer } from '../src/restServer';
import { RegistroSesiones } from '../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';

function request(port: number, opts: { path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'POST', path: opts.path, headers: opts.headers },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('restServer', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let server: http.Server;
  let port: number;
  let apiKey: string;

  beforeAll(async () => {
    await aplicarMigraciones(pool);
    ({ apiKey } = await crearTenant(pool, 'test-tenant', 3));

    const registro = { ejecutar: (_rut: string, fn: any) => fn({}) } as unknown as RegistroSesiones<any>;
    const credenciales = new ProveedorCredencialesRuntime();
    server = crearRestServer(pool, registro, credenciales);
    await new Promise<void>(resolve => server.listen(0, () => { port = (server.address() as any).port; resolve(); }));
  });

  afterAll(async () => { server.close(); await pool.end(); });

  it('GET /health responde 200', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, r => resolve({ status: r.statusCode ?? 0 })).on('error', reject);
    });
    expect(res.status).toBe(200);
  });

  it('sin Authorization responde 401 y audita', async () => {
    const res = await request(port, { path: '/v1/rcv/resumen', body: '{}' });
    expect(res.status).toBe(401);
    const { rows } = await pool.query('SELECT * FROM auditoria WHERE status = 401 ORDER BY id DESC LIMIT 1');
    expect(rows[0].tenant_id).toBeNull();
  });

  it('con API key válida y body válido responde 200', async () => {
    const res = await request(port, {
      path: '/v1/rcv/resumen',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rut: '11.111.111-1', clave: 'x', periodo: '202607', operacion: 'VENTA' }),
    });
    expect(res.status).toBe(200);
  });

  it('ruta desconocida responde 404', async () => {
    const res = await request(port, {
      path: '/v1/no-existe',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2b: Correr el test y confirmar que falla**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/restServer.test.ts`
Expected: FAIL — `src/restServer.ts` no existe.

- [ ] **Step 3: Implementar `restServer.ts`**

Crear `src/restServer.ts`:

```typescript
import * as http from 'http';
import { Pool } from 'pg';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { autenticarTenant } from './rest/auth';
import { chequearRateLimitTenant, chequearRateLimitIp } from './rest/rateLimit';
import { registrarAuditoria } from './rest/auditoria';
import { leerBody, responderJson, BodyDemasiadoGrande } from './rest/http';
import { registrarRutasRcv, RutaHandler } from './rest/rutas/rcv';

const LIMITE_AUTH_FALLIDA_POR_IP = 20;

function ipDe(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? '0.0.0.0';
}

export function crearRestServer(
  pool: Pool,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): http.Server {
  const rutas = new Map<string, RutaHandler>();
  registrarRutasRcv(rutas, registro, credenciales);

  return http.createServer(async (req, res) => {
    const ip = ipDe(req);
    const ruta = `${req.method} ${req.url}`;

    if (req.method === 'GET' && req.url === '/health') {
      try {
        await pool.query('SELECT 1');
        res.writeHead(200).end();
      } catch {
        res.writeHead(503).end();
      }
      return;
    }

    const handler = rutas.get(ruta);
    if (!handler) {
      res.writeHead(404).end();
      return;
    }

    // Límite por IP sobre intentos de auth, antes de resolver tenant: sin
    // esto, probar API keys al voleo no deja rastro ni tiene freno.
    const permitidoPorIp = await chequearRateLimitIp(pool, ip, LIMITE_AUTH_FALLIDA_POR_IP).catch(() => true);
    if (!permitidoPorIp) {
      await registrarAuditoria(pool, { tenantId: null, ip, rut: null, ruta, status: 429, error: 'RATE_LIMITED' });
      responderJson(res, 429, { error: 'RATE_LIMITED' });
      return;
    }

    const authHeader = req.headers.authorization;
    const apiKey = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;

    const tenant = await autenticarTenant(pool, apiKey).catch(() => null);
    if (!tenant) {
      await registrarAuditoria(pool, { tenantId: null, ip, rut: null, ruta, status: 401, error: 'UNAUTHORIZED' });
      responderJson(res, 401, { error: 'UNAUTHORIZED' });
      return;
    }

    const permitidoPorTenant = await chequearRateLimitTenant(pool, tenant.tenantId, tenant.limitePorMinuto)
      .catch(() => true); // fail-open: no tirar el servicio por un problema del contador.
    if (!permitidoPorTenant) {
      await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut: null, ruta, status: 429, error: 'RATE_LIMITED' });
      responderJson(res, 429, { error: 'RATE_LIMITED' });
      return;
    }

    let bodyTexto: string;
    try {
      bodyTexto = await leerBody(req);
    } catch (e) {
      const status = e instanceof BodyDemasiadoGrande ? 413 : 400;
      const error = e instanceof BodyDemasiadoGrande ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
      await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut: null, ruta, status, error });
      responderJson(res, status, { error });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyTexto);
    } catch {
      await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut: null, ruta, status: 400, error: 'BAD_REQUEST' });
      responderJson(res, 400, { error: 'BAD_REQUEST' });
      return;
    }

    const { status, body: respBody } = await handler(body);
    const rut = (body as any)?.rut ?? null;
    const error = (respBody as any)?.error ?? null;
    await registrarAuditoria(pool, { tenantId: tenant.tenantId, ip, rut, ruta, status, error });
    responderJson(res, status, respBody);
  });
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npx jest tests/restServer.test.ts`
Expected: PASS

- [ ] **Step 5: Crear el entrypoint del proceso**

Crear `src/restServerIndex.ts`:

```typescript
import 'dotenv/config';
import { Pool } from 'pg';
import { Browser } from './browser';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { ProveedorCredencialesRuntime } from './credencialesRuntime';
import { crearRestServer } from './restServer';

function requireEnv(nombre: string): string {
  const valor = process.env[nombre];
  if (!valor) throw new Error(`Variable de entorno requerida no encontrada: ${nombre}`);
  return valor;
}

const pool = new Pool({ connectionString: requireEnv('DATABASE_URL'), max: 10 });
const port = Number(process.env.PORT ?? 8790);

const credenciales = new ProveedorCredencialesRuntime();
const registro = new RegistroSesiones<SessionManager>(async rut => {
  const config = await credenciales.para(rut);
  return new SessionManager(config, new Browser(rut));
});

const server = crearRestServer(pool, registro, credenciales);
server.listen(port, () => {
  console.log(`Adaptador REST escuchando en :${port}`);
});
```

- [ ] **Step 6: Build y suite completa**

Run: `npm run build && TEST_DATABASE_URL=postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test npm test`
Expected: build sin errores, todos los tests (incluidos los que necesitan `TEST_DATABASE_URL`) en verde.

- [ ] **Step 7: Agregar el script a `package.json`**

```json
    "start:rest": "node dist/src/restServerIndex.js",
```

- [ ] **Step 8: Commit**

```bash
git add src/rest/rutas/rcv.ts tests/rest/rutas/rcv.test.ts src/restServer.ts src/restServerIndex.ts tests/restServer.test.ts package.json
git commit -m "feat: montar restServer.ts (auth, rate-limit, auditoría, /health, rutas RCV)"
```

---

### Task 12: Verificación end-to-end manual

**Files:** ninguno.

- [ ] **Step 1: Levantar Postgres de test y aplicar migraciones**

```bash
docker compose -f docker-compose.test.yml up -d
export DATABASE_URL="postgres://mcp_sii:mcp_sii@localhost:55432/mcp_sii_test"
npm run build
npm run db:migrar
```

- [ ] **Step 2: Crear un tenant de prueba**

```bash
npm run crear-tenant -- --nombre prueba
```

Copiar la API key que imprime (se muestra una sola vez).

- [ ] **Step 3: Levantar el servidor REST**

```bash
PORT=8790 npm run start:rest
```

- [ ] **Step 4: Probar `/health` y auth**

```bash
curl -s -o /dev/null -w "health: %{http_code}\n" http://localhost:8790/health
curl -s -o /dev/null -w "sin auth: %{http_code}\n" -X POST http://localhost:8790/v1/rcv/resumen -d '{}'
curl -s -o /dev/null -w "auth mala: %{http_code}\n" -X POST http://localhost:8790/v1/rcv/resumen \
  -H "Authorization: Bearer key-que-no-existe" -d '{}'
```

Expected: `200`, `401`, `401`.

- [ ] **Step 5: Probar la ruta con un RUT/clave real de prueba (no de producción)**

```bash
curl -s -X POST http://localhost:8790/v1/rcv/resumen \
  -H "Authorization: Bearer <la-api-key-del-paso-2>" \
  -H "Content-Type: application/json" \
  -d '{"rut":"11111111-1","clave":"clave-de-prueba","periodo":"202607","operacion":"VENTA"}'
```

Expected: `{"ok":true,...}` o `{"ok":false,"error":"CREDENCIALES_INVALIDAS"}` según la clave.

- [ ] **Step 6: Confirmar la auditoría**

```bash
docker exec -it $(docker compose -f docker-compose.test.yml ps -q postgres-test) \
  psql -U mcp_sii -d mcp_sii_test -c "SELECT tenant_id, rut, ruta, status, error FROM auditoria ORDER BY id DESC LIMIT 5;"
```

Expected: una fila por cada request de los pasos 4 y 5, sin ninguna columna con la clave usada.

- [ ] **Step 7: Apagar todo**

```bash
# Ctrl+C en la terminal de npm run start:rest
docker compose -f docker-compose.test.yml down
```

No hay commit en esta task.

---

## Self-Review

**Cobertura del spec (lo que corresponde a este plan — infra + RCV; los otros 5 dominios y la absorción de `validar-clave` quedan para el plan siguiente):**
- Sin Secrets Manager, clave pass-through por request → Task 10 (credenciales por request, `borrar` en `finally`).
- Neon para tenants/API keys/rate-limit/auditoría, sin ORM → Tasks 1, 2.
- Una ruta por operación, bajo `/v1` → Task 10, Task 11.
- Rate limit por tenant y por IP, con auditoría de rechazos → Tasks 6, 7, 11.
- Formato de API key, hash, script CLI → Tasks 3, 4.
- Migraciones SQL planas → Task 2.
- Connection pooling → Task 1.
- `/health` → Task 11.
- Header `Authorization` nunca logueado → Task 11 (nunca se pasa `req.headers` completo a ningún log; sólo `apiKey` extraída se usa para hashear, nunca se imprime).
- Schemas zod compartidos entre MCP y REST → Task 9.
- `PAYLOAD_TOO_LARGE` auditado → Task 11.
- Fail-closed en auth, fail-open en rate-limit por tenant ante caída de Neon → Task 11 (`.catch(() => null)` en auth vs `.catch(() => true)` en rate-limit tenant).

**Explícitamente fuera de este plan** (van en el plan siguiente): los 5 dominios restantes (bhe, dte, renta, mipyme, bienesRaices), absorción de `validar-clave` como `/v1/sesion/validar-clave`, retiro de `httpServer.ts`/`httpServerIndex.ts`, TLS/ALB real (infra de despliegue, no código), retención de `rate_limit_contador`/`auditoria`, idempotencia para `/mipyme/emitir-dte`.

**Placeholders:** ninguno con TBD sin resolver. La única pieza marcada explícitamente para revisar en el momento (el `require(...)` feo de Task 10) tiene su resolución concreta escrita en la Task 11, Step 1 — no es un placeholder, es una secuencia de refactor deliberada dentro del mismo plan.

**Consistencia de tipos:** `RutaHandler` se define en Task 10 (`src/rest/rutas/rcv.ts`) y Task 11 lo importa con la misma firma. `ResumenRcv`/`DetalleRcv`/`OperacionRcv` vienen de `src/scrapers/rcv.ts` (ya existentes) y se usan igual en `core/rcv.ts` y en los tests. `crearRestServer(pool, registro, credenciales)` tiene la misma firma en su definición (Task 11) y en su uso desde `restServerIndex.ts` (Task 11) y desde el test (Task 11).
