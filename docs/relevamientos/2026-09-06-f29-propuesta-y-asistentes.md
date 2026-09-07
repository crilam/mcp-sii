# F29: propuesta, borrador y asistentes — relevamiento

**Fecha:** 2026-09-06 · **Contribuyente de prueba:** Truful SpA (perfil `mipyme` del `.env`) ·
**Períodos usados:** 202607, 202605 y 202512 (declarados y cerrados) y **202608, abierto**,
este último con autorización expresa del dueño para abrir el formulario y leer, sin tocar
ningún botón de guardar, declarar ni pagar.

Encargo de la sesión que lleva el PRD de agenticerp ("Declarar el F29"), para validar
los supuestos de su sección 4.3. **Relevamiento de solo lectura**: no se presentó, cargó,
guardó ni modificó nada en el SII. Los métodos de escritura (`guardarDeclaracion`,
`guardarPropuesta`, `guardarBorradorIntentoPago`, `setComplementoAsistentes`,
`declaracionSinPago`, `crearPagoPec`, `enviarDatosFlujo`) se identificaron pero **no se
invocaron**.

---

## Resumen para quien decide

1. **La aplicación del SII tiene borrador**: expone `hasBorrador`, `guardarDeclaracion`,
   `guardarPropuesta` y una pantalla "Tienes información guardada en el SII". O sea que
   dejar una declaración cargada sin presentar **es algo que la aplicación contempla**.
   No se probó ejecutarlo, por la regla de no escribir.
2. **Los asistentes existen como endpoints propios y son legibles por separado.**
   `getComplementosAsistentes` devuelve un **array posicional por tipo**.
3. **Pero ese endpoint NO devuelve la propuesta del SII**: devuelve lo que el
   contribuyente dejó grabado *al declarar con el asistente*. La evidencia es temporal y
   es contundente (ver §4).
4. **La propuesta SÍ se lee, y con casilleros**: el endpoint es
   `getDeclaracionConCondicionesYTipoPropuesta`, capturado en un período abierto (§3.1).
   Devuelve los códigos propuestos con su valor, los administrativos, el tipo de
   propuesta y una traza del cálculo.
5. **El criterio de fecha es RECEPCIÓN, confirmado contra dos períodos** (§8): el mismo que
   AgenticERP ya aplica. La comparación no va a dar diferencias sistemáticas por ahí.
6. **Recomendación de alcance**: la comparación por origen del PRD **se puede construir**,
   pero contra la propuesta consolidada y el RCV, no "por asistente" — los asistentes son
   dos y no cubren compras (ver §7).

---

## 1. Dónde vive hoy la propuesta del F29

**El CGI del portal mipyme está muerto desde 2017.** `csmSelPeriodoF29.cgi`
(«CÓDIGOS PROPUESTOS PARA F29») todavía responde, pero su propio JavaScript lo dice:

```js
if (EJERCICIO > 2017 || (EJERCICIO == 2017 && MES > 07)) {
    alert("Desde el periodo 08-2017, no se despliega Propuesta de F29 desde este sistema");
}
```

Y el texto de la página lo confirma: *"A partir del Período Tributario 2017-08, los
códigos propuestos para el F29 se obtendrán del Registro de Compras y Ventas (RCV)"*.
Un POST a `csmDespF29.cgi` con un período actual devuelve el error genérico del SII.

Detalle operativo: ese CGI **exige seleccionar empresa primero** y sólo respondió con el
perfil `certificado` (el titular que representa a las empresas); con la clave propia de la
empresa el selector viene vacío. Sin esa selección devuelve
*"No es usuario de la Tributación Simplificada o no ha seleccionado una Empresa"*, que se
lee como si el contribuyente no estuviera en el régimen — es engañoso.

**La aplicación vigente es `https://www4.sii.cl/propuestaf29ui/`**, una SPA SDI (Angular)
llamada "Declarar y Pagar F29". Autenticada con la **clave propia** del contribuyente
muestra: RUT, nombre, período, un enlace «Ver Registro de Compras y Ventas» y el flujo de
declaración.

---

## 2. Endpoints (59 en total, extraídos del bundle)

Base: `https://www4.sii.cl/propuestaf29ui/services/data/{facadeService|facadeAdapterService|riacFacadeService}/{metodo}`

Namespace del sobre SDI — **ojo, es `lob.iva`, no `lob.diii`** como el resto del repo:
`cl.sii.sdi.lob.iva.propuestaf29.data.api.interfaces.{FacadeService|FacadeAdapterService|RiacFacadeService}/{metodo}`

Si se equivoca el namespace, el SII responde **diciendo cuál es el correcto** en
`metaData.errors` — un lujo que no dan otros portales.

### Lectura (verificados en vivo)

| Método | Payload `data` | Devuelve |
|---|---|---|
| `getPeriodosF29` | `{}` | rango declarable: `mesDesde/yearDesde` … `mesHasta:8, yearHasta:2026`, y `periodoData[]` con `formularioId`/`version` |
| `getDeclaracionConEstados` | `{rut, dv, formId:"2", mes, anno}` | **`[{estadoDeclaracionId, monto, folio, estado, declFechaCreacion, enNegocio, codigo, tingcodingreso}]`** |
| `getComplementosAsistentes` | `{scoaRut, scoaDv, scoaPeriodo, scoaTipo:"123"}` | array posicional por tipo (ver §3) |
| `getPpmEnPlazo` | `{rut, dv, formId:"2", formVersion:"2", mes, anno}` | `"S"` / `"N"` |
| `getTasaPPMO` | `{rutContribuyente, dv, mes, anno, categoriaTributaria:1, …}` | casilleros PPM: `cod750, cod563, cod115, cod62, tasaIDPC, periodo, fueraDePlazo, …` |
| `getDeclaracionVigente` | `{periodo}` | `{existe: bool}` |
| `getValidaActecoPrin` (Riac) | `{rut, dv}` | bool |
| `getParametroGlobal` | `"PPTA_ENROLAMIENTO"` (string suelto, no objeto) | valor del parámetro |

### Escritura — identificados, NO invocados

`guardarDeclaracion`, `guardarPropuesta`, `guardarPropuestaTempForRFI`,
`guardarBorradorIntentoPago`, `setComplementoAsistentes`, `declaracionSinPago`,
`generarDeclaracionCuponPago`, `crearPagoPec`, `anularPec`, `enviarDatosFlujo`,
`enrolarContribuyente`.

### La propuesta y los asistentes (capturados en período abierto, §3.1)

| Método | Payload `data` | Devuelve |
|---|---|---|
| `getDeclaracionConCondicionesYTipoPropuesta` | `{rutContribuyente, dv, formCodigo:"2", mes, anno}` | **la propuesta**: ver §3.1 |
| `getBoletasHonorario` (Riac) | `{rutContribuyente, dv, mes, anno, paginaActual:1}` | `{listBoletasHonorarios[], honorariosBrutoTotal, honorariosRetencionEmisorTotal, honorariosRetencionReceptorTotal, honorariosLiquidoTotal, totalPaginas, totalRegistros, bhep}` |
| `getBoletasPrestacionT` (Riac) | igual que el anterior | misma forma, `bhep:null` |
| `getMensajesContribuyente` | `{rut, periodo, formId:"2", tipo:"IP"}` | mensajes al contribuyente, `null` si no hay |

### Con contrato aún pendiente

`getCodigosPropuestos`, `hasBorrador`, `obtenerCodigosPrimitiva`, `getFormularioMetaData`.
No se los vio en el flujo capturado —la app usa
`getDeclaracionConCondicionesYTipoPropuesta` para la propuesta—, así que probablemente
pertenezcan al camino de rectificatoria. **No hacen falta** para lo que pide el PRD.

---

## 3. Los asistentes (preguntas 5 a 8)

`getComplementosAsistentes` con `scoaTipo:"123"` devuelve **un array de tres posiciones,
una por tipo**. Para Truful, en los tres períodos medidos:

```json
[null, null, {"scoaTipo":3, "scoaRealizado":"S", ...}]
```

**Pregunta 8, respondida:** cuando un asistente no aplica, **la posición viene `null`** —
no cero, no ausente. Un `null` es "este asistente no se usó"; un objeto con
`scoaRealizado:"S"` es "se usó". Pedir `scoaTipo:"1234"` o `"12345"` devuelve igual tres
posiciones: **sólo existen los tipos 1, 2 y 3.**

**Los campos revelan dos familias dentro del mismo objeto:**

- **Honorarios/boletas**: `scoaCantidad`, `scoaBrutos`, `scoaRetencionEmisor`,
  `scoaRetencionReceptor`, `scoaLiquidos`, `scoaTotal`
- **PPM**: `scoaPpmoCod750`, `scoaPpmoCod30`, `scoaPpmoCod115`, `scoaPpmoCod563`,
  `scoaPpmoCod68`, `scoaPpmoOtros`, `scoaPpmoRentaLiquida`, `scoaPpmoRentaProvisoria`

**El tipo 3 es el asistente de PPM**, y la prueba es numérica:

| Período | `scoaPpmoCod563` | `scoaPpmoCod115` | Monto declarado |
|---|---|---|---|
| 202512 | 30.801.047 | 0.125 | $6.130.840 |
| 202605 | 0 | null | $0 |
| 202607 | 0 | null | $0 |

Los tipos 1 y 2 vinieron `null` en los tres períodos cerrados, y en el período abierto los
tres vienen `null` (`[null,null,null]`): todavía no se usó ninguno.

### 3.1 Qué asistentes ofrece de verdad la pantalla

La captura del período abierto muestra que **el formulario ofrece DOS asistentes**, con su
estado al lado:

| Asistente en pantalla | Estado mostrado |
|---|---|
| **Asistente Pago Provisional Mensual (PPM)** | No Realizado |
| **Boletas de Ventas y Servicios** | Realizado |

**No hay un asistente de compras ni uno de honorarios en esta pantalla.** Eso responde la
pregunta 5 y corrige el supuesto del encargo:

- **Las compras no pasan por un asistente**: entran solas desde el RCV. La propuesta lo
  declara con `complementoDetalleDTE: true` y `documentosDelGiro: true`.
- **Las boletas de honorarios tampoco tienen asistente propio acá**, pero **sí tienen
  endpoint**: `getBoletasHonorario` y `getBoletasPrestacionT` (§2), que la app llama al
  entrar al período.

### 3.2 La propuesta: `getDeclaracionConCondicionesYTipoPropuesta`

Es el endpoint que arma la propuesta del período. Payload
`{rutContribuyente, dv, formCodigo:"2", mes, anno}`. Devuelve:

| Campo | Qué trae |
|---|---|
| `listCodPropuestos` | **los casilleros propuestos**: `[{codigo, valor}]`. En la corrida real vinieron los códigos 110, 111, 115, 504, 511, 519, 520, 562, 563 y 584 |
| `listCodAdministrativos` | códigos 9114, 9126, 9129, 9132, 9137, 9192, 9193, con los mismos valores que sus pares del formulario |
| `listCodBase` | identificación: razón social, RUT, dirección, comuna y período (código 15) |
| `tipopropuesta` | entero (40 en la corrida); `tipopropuestadescrip` vino `null` |
| `listCondiciones`, `listGlosasProp`, `listCodComplementar` | vacíos en el caso medido |
| `complementoDetalleDTE`, `documentosDelGiro` | `true` — el detalle viene del RCV |
| `estado`, `tieneAnotaciones`, `anotacion` | `0`, `false`, `false` |
| `resultadoCalculoPP29.traza` | **traza textual del cálculo**, con RUT y período. Útil para diagnóstico; **no loguear tal cual**, lleva identificadores |

Los valores concretos no se transcriben acá a propósito: este repositorio es público y son
datos tributarios de un contribuyente real. Se reproducen corriendo la captura.

**Pregunta 8, matizada por la evidencia nueva:** hay dos comportamientos distintos según
dónde se pregunte. `getComplementosAsistentes` devuelve **`null`** en la posición del
asistente no usado; en cambio `getBoletasHonorario` con una empresa sin honorarios
devuelve **ceros y lista vacía** (`listBoletasHonorarios: []`, `totalRegistros: 0`), no
`null` ni error. Son dos convenciones diferentes en la misma aplicación.

---

## 4. El hallazgo que cambia la interpretación (pregunta 7)

`getComplementosAsistentes` **no devuelve la propuesta del SII**. Devuelve lo que el
contribuyente dejó grabado **en el momento de declarar**. La evidencia es el cruce de
marcas de tiempo:

| Período | `scoaFechaIngreso` del asistente | `declFechaCreacion` de la declaración | Diferencia |
|---|---|---|---|
| 202607 | 2026-08-10 10:27:31 | 10/08/2026 10:28:02 | **31 segundos** |
| 202605 | 2026-06-15 10:04:24 | 15/06/2026 10:04:54 | **30 segundos** |
| 202512 | 2026-01-14 08:54:37 | 20/01/2026 18:27:17 | 6 días |

En dos de tres casos el complemento se graba medio minuto antes que la declaración: es el
rastro de alguien usando el asistente y declarando a continuación. El caso de 202512
(seis días antes) muestra además que **el complemento puede quedar guardado sin declarar
todavía** — lo que refuerza que el borrador existe, pero también que ese dato es del
contribuyente, no del Servicio.

**Consecuencia para el PRD**: este endpoint sirve como **evidencia de auditoría** ("con
qué valores se declaró y cuándo"), no como la propuesta a comparar antes de declarar. La
comparación previa tiene que hacerse contra el RCV —que mcp-sii ya importa— o contra
`getCodigosPropuestos`, cuyo contrato falta.

**Sobre el criterio de fecha del RCV**: no se pudo comparar el asistente de compras contra
el RCV importado, porque el asistente de compras (tipo 1 o 2) vino `null` en todos los
períodos medidos. Queda sin responder si usa el mismo criterio de fecha.

---

## 5. Atribuciones de la clave (pregunta 3)

Medido en esta misma sesión, con dos credenciales distintas sobre las mismas empresas:

| Operación | Certificado del representante | Clave propia del contribuyente |
|---|---|---|
| Estado de la declaración (`sifmConsultaInternet`, GWT) | **funciona** | funciona |
| PDF del formulario compacto (`rfiInternet/formCompacto`) | **"No está autorizado para realizar esta acción"** | **funciona** |
| Portal mipyme: selector de empresas y CGI `csm` | **funciona** | selector vacío |
| App `propuestaf29ui` y sus lecturas | no probado | **funciona** |

Dos credenciales con atribuciones **distintas y complementarias**: el certificado del
representante sirve para consultar el estado y para operar el portal mipyme; la clave
propia sirve para imprimir el formulario y para entrar a la aplicación de declaración.
Se probó con dos empresas distintas antes de concluirlo, así que no es un caso aislado.

**Lo que esto implica para el PRD**: si el sistema va a declarar o a dejar cargado, va a
necesitar la **clave propia de cada empresa**, no el certificado del representante. Eso
sube el perfil de riesgo del almacenamiento cifrado respecto de un sistema que sólo
consulta. **No se verificó** si declarar exige alguna atribución adicional sobre la misma
clave: eso sólo se sabe intentando declarar, que está fuera del alcance de este
relevamiento.

---

## 6. Qué quedó fuera

Con la captura del período abierto quedaron respondidas las preguntas 2, 5, 6, 7 y 8.
Sigue **sin verificar**, y a propósito:

- **Que la escritura funcione.** `guardarDeclaracion` / `guardarPropuesta` /
  `guardarBorradorIntentoPago` no se invocaron. No sabemos si dejan la declaración
  visible para el administrador, si crean folio, si son reversibles ni si bloquean el
  período. Es lo único que separa "dejar cargado" de una suposición.
- **Qué atribución exige declarar.** Se sabe que la clave propia abre la aplicación y
  lee todo; no se sabe si enviar exige algo más.
- **El criterio de fecha del RCV frente al de la propuesta.** La propuesta dice tomar el
  detalle del RCV (`complementoDetalleDTE: true`), pero no se comparó documento a
  documento contra el RCV que ya importamos. **Es la verificación que más valor tiene
  ahora**, y es de solo lectura: bajar el RCV del período y contrastar los totales contra
  `listCodPropuestos`.

---

## 7. Recomendación sobre la sección 4.3 del PRD

**La comparación a tres fuentes se puede construir**, con una corrección importante sobre
cómo estaba planteada.

**Lo que cambia:** no hay "un asistente por origen". Hay **dos** asistentes (PPM y Boletas
de Ventas y Servicios) y las compras **no** pasan por asistente: entran solas desde el
RCV. Así que la comparación por origen no se hace "asistente contra libro", sino:

| Origen | Fuente del SII para comparar |
|---|---|
| Compras | `listCodPropuestos` (códigos de crédito) + el RCV que ya importamos, documento a documento |
| Ventas | `listCodPropuestos` (códigos de débito) + RCV |
| Honorarios | `getBoletasHonorario` / `getBoletasPrestacionT`, que dan totales y detalle paginado |
| PPM | `getTasaPPMO` y el asistente tipo 3 |

Con eso el diagnóstico accionable que pedía el PRD **es alcanzable**: se puede decir "el
SII propone X en el código 520 y el libro dice Y", y con el RCV bajar al documento que
explica la diferencia.

**Sobre dejar la declaración cargada.** Sigue siendo el punto caro: exige una escritura
que nadie ejecutó nunca, con la credencial más sensible, en un flujo donde equivocarse es
indistinguible de declarar mal. Y el relevamiento muestra que **el administrador ya tiene
la propuesta armada al entrar**: el SII le precarga los casilleros y le ofrece los
asistentes. Si declarar con eso es fácil —como dice el dueño—, el sistema aporta más
cuadrando y avisando que cargando.

**Propuesta concreta para 4.3:**

1. **Fase 1 (todo lectura, construible ya)**: cuadrar `listCodPropuestos` contra el libro
   propio y el RCV, y entregar el diagnóstico por origen con el documento que descuadra,
   más un enlace directo al período en `propuestaf29ui`.
2. **Fase 2 (requiere autorización aparte)**: probar `guardarDeclaracion` en un período
   real y recién ahí decidir si conviene dejar cargado.

El corte entre fase 1 y fase 2 es exactamente el corte entre lo verificado y lo supuesto.

---

## 8. El criterio de fecha: RECEPCIÓN, confirmado

Era la verificación que más valor tenía y salió limpia. Se comparó, en dos períodos
declarados, el RCV de compras contra `listCodPropuestos` de la propuesta del SII.

| Período | RCV de compras (del período consultado) | Propuesta del SII |
|---|---|---|
| 202606 | tipo 33: **1** documento, IVA **978** | `519=1`, `520=978`, `511=978` |
| 202607 | tipo 33: **2** documentos, IVA **96.995**; nota de crédito (61): **1**, IVA **1.900** | `519=2`, `520=96995`, `527=1`, `528=1900`, `511=95095` |

Cuadra exacto, incluida la aritmética interna: `511 = 520 − 528` (95.095 = 96.995 − 1.900),
o sea el crédito neto después de las notas de crédito. Las cantidades de documentos también
coinciden una a una (`519` y `527`).

**La prueba del criterio es el documento desfasado.** En 202606 hay una factura **emitida
el 31/05/2026 y recibida el 11/06/2026**, y está dentro del período 202606 del RCV — el
caso que el PRD identificó. En 202607 se repite el patrón con otra emitida el 30/06 y
recibida el 03/07. Si el SII agrupara por emisión, esos documentos estarían en el mes
anterior. **Todas las fechas de recepción de cada período caen dentro del propio período.**

**Conclusión: el SII agrupa por fecha de RECEPCIÓN (Art. 24), que es el mismo criterio que
AgenticERP aplica con `recorded_period`.** La comparación no va a dar diferencias
sistemáticas por este motivo.

Matiz honesto: los dos documentos desfasados que se encontraron son de tipo 34 (exenta) con
IVA 0, así que no mueven el `520`. Lo que prueban es la **pertenencia al período**, que es
justamente lo que estaba en duda. Un caso desfasado con IVA distinto de cero sería la
confirmación redonda; no apareció en los períodos disponibles.

---

## 9. Contrato de sesión para un cliente propio

Para llamar estos endpoints desde `packages/sii-client`, que hoy ya hace el RCV contra
`consdcvinternetui`: **es el mismo mecanismo, no hace falta nada nuevo.**

**Autenticación**: login estándar del SII con **clave propia del contribuyente** (no sirve
el certificado del representante, §5). No hay login específico de la aplicación: se
autentica una vez contra el SII y la cookie sirve para todo el dominio.

**Transporte**: `POST` con `Content-Type: application/json` y el cookie jar de la sesión.
Sin headers extra. **No hay CSRF, ni token en el body, ni Referer obligatorio** — se
verificó llamando por HTTP directo, fuera del navegador, y respondieron igual.

**El sobre** (idéntico al del RCV):

```json
{
  "metaData": {
    "namespace": "<namespace>/<metodo>",
    "conversationId": "<valor de la cookie TOKEN>",
    "transactionId": "<único por petición>",
    "page": null
  },
  "data": { }
}
```

- **`conversationId` es el valor de la cookie `TOKEN`** que deja el login. No se inventa.
- `transactionId` sólo necesita ser único por petición; cualquier cadena única sirve.
- **El namespace es `cl.sii.sdi.lob.iva.propuestaf29…`** — `lob.iva`, no `lob.diii` como el
  resto del repo. Si se equivoca, el SII responde en `metaData.errors` **diciendo cuál es
  el correcto**, lo que hace muy barato descubrirlo.

**Errores**: HTTP 200 con `metaData.errors` cuando el sobre está mal; **HTTP 400 con una
página HTML de JBoss** cuando el `data` no tiene la forma esperada. El 400 no dice qué
falta: por eso los payloads hay que capturarlos del navegador y no adivinarlos — se
probaron cuatro formas de `getCodigosPropuestos` y todas dieron 400.

**Un período ya declarado sigue respondiendo la propuesta por HTTP**, aunque la interfaz
corte antes con "Existe una declaración vigente". Útil para reproducir y testear sobre
períodos cerrados.

---

## 10. Fixtures

En `docs/relevamientos/fixtures/`, con la estructura exacta del SII y todo dato
identificatorio sustituido (RUT ficticio 11.111.111-1, razón social "EMPRESA DE PRUEBA
SPA", dirección inventada, y la traza del cálculo con el RUT sustituido):

| Archivo | Qué muestra |
|---|---|
| `f29-propuesta-declaracion-con-condiciones.json` | respuesta completa de la propuesta |
| `f29-boletas-honorario-vacio.json` | convención "sin datos" de boletas: **ceros y lista vacía** |
| `f29-complementos-asistentes-vacio.json` | convención "sin datos" de asistentes: **null por posición** |
| `f29-tasa-ppmo.json` | casilleros de PPM |

**Detalles de tipos que importan para escribir el cliente**, y que se ven en los fixtures:

- **Los montos vienen como `string`, no como number** (`{"codigo":"520","valor":"96995"}`).
  Incluye la tasa: `"115": "0.125"`.
- `getTasaPPMO` **mezcla**: `cod563` y `cod115` son string, `mes` y `anno` son number.
- Abundan los `null` en campos opcionales; no asumir presencia.
- Las dos convenciones de "sin datos" conviven en la misma aplicación: hay que tratarlas
  por endpoint, no con una regla global.

**Lo que NO hay**: un fixture de `getBoletasHonorario` **con** datos. El contribuyente de
prueba no tiene boletas de honorarios en ningún período consultado, así que
`listBoletasHonorarios` siempre vino vacío y **la forma de sus elementos no se relevó**. No
se inventa: hay que capturarlo con un contribuyente que sí las tenga.

---

## Anexo: reproducir este relevamiento

Los scripts de captura usados quedaron fuera del repo (son de un solo uso y llevan
credenciales por entorno). El camino es:

- **Endpoints del bundle**: `GET https://www4.sii.cl/propuestaf29ui/` → leer el
  `app.full.*.min.js` → extraer `"/propuestaf29ui/services/…"`.
- **Payloads reales**: interceptor de `XMLHttpRequest` inyectado con `browser.eval()`
  (patrón de `src/scripts/relevarF29Rpc.ts`), y después navegar la app.
- **Lecturas por HTTP**: `SiiHttpClient.postSdi(base, namespace, metodo, data)` — ya
  soporta este sobre; sólo hay que pasarle el namespace `lob.iva`.
- Ritmo: `pausaConfigurada()` entre llamadas, como exige `src/ritmoSii.ts`.
