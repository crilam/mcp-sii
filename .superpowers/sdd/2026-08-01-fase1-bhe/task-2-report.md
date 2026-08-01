# Task 2: SiiHttpClient - Report

## Resumen
Se implementó la clase `SiiHttpClient` que actúa como transporte HTTP reutilizando la sesión autenticada del `SessionManager`. La clase hace peticiones curl contra el portal del SII, utilizando el cookie jar compartido para mantener la sesión activa.

## Archivos Creados

### `src/http.ts`
- Clase `SiiHttpClient` que toma un `SessionManager` en su constructor
- Método `async get(url: string, params?: Record<string, string>): Promise<string>` para peticiones GET
- Método `async postForm(url: string, campos: Record<string, string>): Promise<string>` para peticiones POST con form encoding
- Usa `execSync` de Node.js para ejecutar curl
- Reutiliza el cookie jar del `SessionManager` via `rutaCookieJar()`
- Decodifica respuestas como ISO-8859-1 (latin1) como lo requiere el SII
- Escapa correctamente los parámetros con `encodeURIComponent`

### `tests/http.test.ts`
- 5 tests que cubren:
  1. Que se manden las cookies de la sesión compartida
  2. Que se agreguen parámetros al query string
  3. Que se decodifique la respuesta como ISO-8859-1
  4. Que se manden los campos como application/x-www-form-urlencoded
  5. Que se escapen valores con caracteres especiales

## Ejecución de Tests

### Tests de http.test.ts
```
$ npx jest tests/http.test.ts

Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        0.612 s
```

### Todos los tests
```
$ npx jest

Test Suites: 12 passed, 12 total
Tests:       76 passed, 76 total
Snapshots:   0 total
Time:        0.698 s, estimated 1 s
```

### Verificación de tipos
```
$ npx tsc --noEmit
(sin errores)
```

## Commit
```
5abe533 feat: agregar SiiHttpClient con sesión compartida y encoding ISO-8859-1
```

## Auto-revisión

- ✅ La clase reutiliza correctamente el cookie jar del SessionManager
- ✅ Respeta la restricción global: una sola sesión por proceso (no autentica por su cuenta)
- ✅ Maneja correctamente el encoding ISO-8859-1 como requiere el SII
- ✅ Escapa correctamente los parámetros con encodeURIComponent
- ✅ La implementación usa curl vía execSync como se requiere
- ✅ Sin dependencias nuevas
- ✅ Los nombres y firmas coinciden exactamente con el brief
- ✅ Los 5 tests nuevos pasan
- ✅ El total es 76 tests (71 previos + 5 nuevos)
- ✅ Sin errores de tipos

## Dudas
Ninguna.

---

## Arreglo de Seguridad (Post-Review)

### Hallazgo Importante
La revisión de Spec detectó que `src/http.ts:121` y `src/http.ts:125` interpolaban el parámetro `url` crudo dentro de un string de shell sin escapado. A diferencia de `campos`/`params` (que se escapaban via `encodeURIComponent`), `url` no recibía tratamiento. Esto permitía que un valor con metacaracteres de shell (`"`, `` ` ``, `$()`, `;`, etc.) rompiera las comillas del comando `curl` y ejecutara código arbitrario vía `execSync`.

El riesgo era **latente** (no había callers hoy), pero debía mitigarse en la clase de problema, no parchearse.

### Solución Implementada
Se eliminó la clase de problema completa usando `execFileSync('curl', [...args])` con argumentos como arreglo, siguiendo el patrón ya existente en `src/validateCert.ts`:

1. **Cambio en `src/http.ts`:**
   - Migró de `execSync(string_comando)` a `execFileSync('curl', arreglo_argumentos)`
   - Los argumentos ahora se pasan como un arreglo: `['-sk', '-b', jar, '-L', ...]`
   - Ningún valor pasa por un intérprete de comandos, así que metacaracteres son literales y seguros
   - Removió `.toString()` redundante en la llamada (cuando se pasa `encoding`, `execFileSync` ya retorna un string)

2. **Cambios en `tests/http.test.ts`:**
   - Migró de mockear `execSync` a mockear `execFileSync`
   - Actualizó las aserciones para verificar el arreglo de argumentos en lugar de buscar strings en un comando shell
   - Agregó 2 tests nuevos de seguridad:
     - `previene inyección de shell en la URL`: inyecta `"; echo "hacked` en la URL y verifica que sea literal
     - `URL con backtick, $() y punto y coma son literales`: inyecta `` `whoami`$(cat /etc/passwd); `` y verifica que sea literal

### Ejecución de Tests (Post-Arreglo)

```
$ npx jest tests/http.test.ts

Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total (5 originales + 2 nuevos de seguridad)
Snapshots:   0 total
Time:        0.61 s
```

```
$ npx jest

Test Suites: 12 passed, 12 total
Tests:       78 passed, 78 total (71 previos + 7 nuevos en http.test.ts)
Snapshots:   0 total
Time:        0.661 s
```

```
$ npx tsc --noEmit
(sin errores)
```

### Commit de Arreglo
```
49d8727 fix: prevenir inyección de shell en URLs usando execFileSync con argumentos como arreglo
```

### Verificación de Arreglo
- ✅ Usa `execFileSync` con argumentos como arreglo, elimina clase de vulnerabilidad completa
- ✅ Sigue el patrón ya existente en `src/validateCert.ts` de este mismo repo
- ✅ URLs con metacaracteres de shell ahora son literales (sin riesgo de inyección)
- ✅ Parámetros siguen escapándose correctamente con `encodeURIComponent`
- ✅ Tests cubren tanto la seguridad (2 nuevos) como la funcionalidad original (5 previos)
- ✅ Total: 78 tests pasando
- ✅ Sin errores de tipos
