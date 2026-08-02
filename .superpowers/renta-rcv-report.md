# Transporte SDI, Renta F22 y Registro de Compras y Ventas

Fecha: 2026-08-01
Rama: `feat/renta-rcv`

Implementa el transporte para las APIs REST modernas del portal del SII y las dos
áreas construidas encima: el estado de la declaración de renta (F22) y el resumen
del Registro de Compras y Ventas (RCV).

Contratos de referencia (verificados en vivo, no se re-verificaron acá):
`docs/superpowers/specs/2026-08-01-sdi-rest-contratos.md` y
`docs/superpowers/specs/2026-08-01-f29-rcv-contratos.md`.

## 1. El sobre SDI: `SiiHttpClient.postSdi()`

`postSdi(baseUrl, namespace, metodo, data)` arma el sobre que exigen las
aplicaciones de `www4.sii.cl/<app>ui/` y devuelve el JSON parseado:

```json
{ "metaData": { "namespace": "<interfaz>/<metodo>", "conversationId": "<cookie TOKEN>",
                "transactionId": "<único por petición>", "page": null },
  "data": { ...parámetros... } }
```

Decisiones:

- **El `conversationId` lo resuelve `SessionManager`**, con un método nuevo
  (`conversationId()`) que parsea el cookie jar Netscape reusando el
  `parseCookieFile` que ya existía, y falla explícito si no hay cookie `TOKEN`.
  El transporte no lee el archivo por su cuenta: hay un solo lugar que sabe
  dónde vive el jar y con qué formato.
- `postSdi` llama primero a `rutaCookieJar()` para forzar la autenticación (es
  idempotente y reusa la sesión vigente) y recién después lee la cookie: sin
  sesión no hay TOKEN.
- El `transactionId` se arma con reloj + contador + azar, sin dependencias
  nuevas. Sólo necesita ser único por petición.
- Una respuesta que no es JSON (HTML del login, error del portal) corta ahí con
  un extracto, en vez de romper el parser mucho más lejos de la causa.
- **Comentario de advertencia sobre `"Acceso no autorizado!"`**, en el
  transporte y repetido en el mensaje de error de los dos scrapers: ese mensaje
  apunta a permisos cuando en realidad es el sobre mal formado.

Se mantiene `execFileSync` con arreglo de argumentos, igual que el resto del
cliente: ninguna dependencia nueva.

## 2. Renta F22

`src/scrapers/renta.ts` + `src/tools/renta.ts`.

- Base `consultaestadof22ui`, namespace
  `cl.sii.sdi.lob.renta.consultaestadof22.data.api.interfaces.FacadeService`.
- `rut` sin dígito verificador y `dv` aparte, desde `session.identidad()`.
  `periodo` es el año tributario como cadena.
- `buscaDeclVgte` → `{anio, sinDatos, declaraciones[], glosas[]}`. **Las glosas
  no se omiten**: son el texto que explica el estado (si hubo devolución y por
  cuánto, o qué inconsistencia se detectó), lo más útil de la respuesta.
- `f22Completo` → las 76 líneas `{codigo, valor, glosa}`.
- Códigos de renta: `data` con contenido es éxito (el `respCod` puede venir en 0
  o directamente ausente según el método); `respCod: 2` con `data: null` es
  **sin datos**, un vacío legítimo. Cualquier otra combinación lanza: reportar
  como vacío algo que no se entiende escondería un error.
- El `evigCodigo` se expone crudo, sin traducir a texto: inventar una traducción
  propia agregaría significado que el SII no dio. Lo que explica el estado son
  las glosas.
- La dirección se limpia de los literales `"null"` que el SII concatena
  (`"CALLE EJEMPLO 123 null"`).

**Tools:** `sii_renta_estado_declaracion(anio)` y `sii_renta_get_f22(anio, folio?)`.

El folio es opcional y se resuelve desde la declaración vigente del año (una
consulta extra a `buscaDeclVgte`), lo cual está dicho explícitamente en la
descripción de la tool. Si el año no tiene declaración vigente **falla pidiendo
el folio**, en vez de devolver un formulario vacío que se leería como "ese año no
tiene datos".

## 3. Registro de Compras y Ventas

`src/scrapers/rcv.ts` + `src/tools/rcv.ts`.

- Base `consdcvinternetui`, namespace
  `cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService`,
  `getResumen` con `estadoContab: "REGISTRO"`.
- **Los cuatro códigos propios se mapean explícitamente**
  (`respEstado.codRespuesta`): `0` éxito, `3` sin datos para el período (vacío
  legítimo, `sinDatos: true` con totales en cero), `2` error (lanza citando
  `msgeRespuesta`), `98` redirección (lanza). Un código desconocido también
  lanza. Confundir el `3` con un error reportaría un mes tranquilo como falla, y
  confundir el `2` con vacío escondería un error real detrás de un resumen en
  cero que se ve perfectamente normal.
- **Las notas de crédito restan.** Los tipos 61 (electrónica) y 60 (papel) se
  marcan con `esNotaCredito` y entran con signo negativo en `totales`. El SII las
  informa con montos positivos, exactamente igual que una factura: sumarlas infla
  ventas e IVA y produce cifras que parecen plausibles. Hay un test que fija los
  totales correctos y además afirma que **no** son los de la suma ingenua.
- **La empresa es un parámetro de la llamada**, no un estado de la sesión: se
  puede consultar una empresa distinta en cada llamada sin pasar por ninguna
  pantalla de selección. Sin `empresa_rut` se usa el RUT autenticado.
- Se validan el período (`AAAAMM`) y el RUT de empresa antes de tocar la red.

**Tool:** `sii_rcv_resumen(periodo, operacion, empresa_rut?)`. La descripción
declara que es solo lectura (no toca `ingresarAceptacionReclamoDocs`), que
`totales` viene con las notas de crédito restadas, y que `sinDatos` es un mes sin
movimientos y no un error.

## Restricciones respetadas

- **Una sola sesión por proceso:** los dos scrapers reciben el mismo
  `SessionManager` y el mismo `SiiHttpClient` que ya usa BHE; ninguno autentica
  por su cuenta. Los dos preguntan `assertPuedeEntregarCookieJar()` **antes** de
  consultar, para no abrir en el SII una sesión que no se va a poder usar.
- Las tools de renta no exigen `SII_EMPRESA_RUT` y lo dicen en su descripción.
- Ninguna fixture fue modificada.
- Sin dependencias nuevas.

## Verificación

- `npx tsc --noEmit` — limpio.
- `npx jest` — **238 tests, 23 suites, todos en verde** (eran 184).
- `npm run build` — limpio.
- El chequeo de anonimización sigue verde sobre todo lo versionado.

## Concerns y límites conocidos

1. **Nada de esto se ejecutó contra el portal real en esta sesión.** El parseo
   está verificado contra las fixtures capturadas; los contratos vienen de las
   spikes previas.
2. **No hay fixture de un RCV de compras ni de un período vacío real.** El caso
   `COMPRA` y el código `3` se ejercitan con respuestas construidas a mano. Si el
   RCV de compras trae campos distintos —como pasó entre BHE emitidas y
   recibidas— el parser devolvería ceros sin avisar.
3. **La lista de notas de crédito es una constante de dos códigos (61 y 60).** Si
   el SII usa otro código de documento que también rebaja (por ejemplo alguna
   variante de nota de crédito de exportación), se sumaría en vez de restarse, y
   el error sería silencioso. Vale revisarlo contra `getDatosInicio`, que
   devuelve el catálogo completo de tipos de documento.
4. **`f22Completo` sin folio hace dos consultas al SII.** Es la única tool del
   proyecto que consulta dos veces por invocación; no afecta la sesión, pero
   duplica la latencia.
5. **`buscaObservacion` quedó afuera**, como recomienda la spec: devuelve
   `respCod: 2` tanto para "sin observaciones" como potencialmente para
   parámetros incorrectos, y no se puede distinguir sin una declaración
   observada.
6. **La fixture del F22 completo trae `namespace` terminado en `f22Compacto`,
   no en `f22Completo`.** El parseo no depende de ese campo, así que no cambia
   nada acá, pero si el método correcto fuera `f22Compacto` la consulta real
   fallaría. Vale confirmarlo contra el portal antes de usarlo en serio.
