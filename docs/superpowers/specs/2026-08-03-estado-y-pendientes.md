# Estado y pendientes

Fecha: 2026-08-03
Estado: **mapa de sesión.** No entrega contratos nuevos; ordena lo que ya está resuelto, lo que falta, y qué de lo que falta no depende de escribir código.

Punto de entrada para una sesión nueva. Cada afirmación de acá tiene su respaldo en un documento propio, enlazado. Si algo se contradice, gana el documento específico y este se corrige.

## 1. Dónde está el proyecto

`main` en `6465b28`. Suite verde: **390 tests, 26 suites**.

16 tools registradas, en dos transportes:

| Transporte | Tools | Archivos |
|---|---|---|
| **HTTP directo** (sobre SDI o formularios) | `sii_dte_list_documentos_emitidos` / `_recibidos`, `sii_dte_get_documento_emitido` / `_recibido`, `sii_rcv_resumen`, `sii_rcv_detalle`, `sii_renta_get_f22`, `sii_renta_estado_declaracion`, `sii_bhe_list_emitidas`, `sii_bhe_list_recibidas`, `sii_bhe_resumen` | `scrapers/{dte,rcv,renta,bhe}.ts` |
| **Navegador** (`agent-browser`) | `sii_mipyme_list_empresas`, `sii_mipyme_list_dte_emitidos`, `sii_mipyme_emitir_dte`, `sii_persona_list_bienes_raices` | `scrapers/{mipyme,bienesRaices}.ts`, `browser.ts` |

`sii_cerrar_sesion` cierra la sesión compartida por ambos caminos.

Lo último que se movió: `sii_dte_*` pasó de navegador a HTTP (#21). Eso deja `mipyme.ts` (665 líneas, ~70 llamadas al navegador) y `bienesRaices.ts` (211 líneas, 3 llamadas) como el resto de la deuda de navegador.

### Los dos hallazgos de transporte que ya no hay que redescubrir

1. **El sobre SDI** ([spec](2026-08-01-sdi-rest-contratos.md)) sirve para toda aplicación en `www4.sii.cl/<app>ui/`. Cambia sólo `namespace` y base de URL. Está implementado en `SiiHttpClient.postSdi()`.
2. **El puente `legacy/bridge2`** ([spec](2026-08-01-representacion-empresa.md)) da acceso a las aplicaciones de tercera generación del portal desde la sesión legacy. Genérico, no específico del dominio de representantes.

## 2. La regla

Es una sola y explica casi todas las decisiones tomadas hasta acá:

> **Un vacío nunca puede significar dos cosas.** Y lo desconocido falla citando el código, no se interpreta.

Aplicaciones concretas, todas fijadas por tests:

- RCV: `codRespuesta 3` es un período sin movimientos (vacío legítimo); `2` es error. `sinDatos` lo separa del fallo.
- DTE: `estadoDetalle` distingue `no_pedido` / `incluido` / `sin_filas_que_pedir`, porque `documentos: []` significaba tres cosas.
- DTE: `origenDeMontos` dice si las cifras son `declarados_por_el_sii`, `suma_de_documentos` o `sin_montos`. `totales` es `null` cuando no se sumó nada — nunca cero.
- DTE: un filtro (`contraparte_rut`, `limit`) sin detalle **falla antes de consultar**, en vez de devolver el período completo como si fuera el filtrado.
- **`codRespuesta` no es una tabla compartida**: el `99` de Consultas DTE es "usuario no autorizado" y el `99` del RCV es período fuera de rango. Cada aplicación necesita su propio mapeo.

Dos corolarios operativos:

- **Una sola sesión por proceso.** Dos sesiones simultáneas contra el mismo RUT disparan el bloqueo del SII. Por eso `server.ts` comparte un único `SessionManager`.
- **Ninguna fixture con datos reales.** RUT anonimizados con dígito repetido (`22222222-2`, `33333333-3`, …). Hay tests que lo verifican.

Y una regla de método, aprendida a costa de una spike mal leída: **al probar autorización, los datos tienen que ser reales.** Un rechazo con un RUT ficticio no significa nada — así se inventó un modelo de autorización que no existía.

## 3. Pendientes, ordenados por si dependen de vos o no

### Se pueden hacer ya, sin nada de afuera

1. **`sii_dte_*` y `sii_rcv_*` no son comparables** y ya lo dicen sus descripciones. Lo que falta es *por qué* difieren los recibidos (85 contra 83 facturas, 3 contra 5 notas de crédito). Hipótesis sin verificar: el RCV refleja lo que el contribuyente registró o aceptó; Consultas DTE, lo que el SII recibió. Se confirma comparando documento por documento con `sii_rcv_detalle` y el detalle de DTE — las dos tools ya existen. ([spec](2026-08-03-migrar-navegador-a-http.md))
2. **Migrar el portal mipyme a HTTP.** Es la deuda grande de navegador (~70 llamadas) y no está relevada. **Es el prerrequisito de todo lo multi-empresa**: con una credencial por empresa hace falta una sesión por identidad, y un Chrome con un solo almacén de cookies no puede sostener dos. `getEmpContribuyente` ya mostró que la selección de empresa probablemente desaparece en el camino HTTP.
3. **`buscaObservacion` (renta F22)** devolvió `respCod: 2` contra una declaración limpia, y eso no distingue "sin observaciones" de "parámetros incorrectos". Requiere una declaración **observada** para verificar. Hasta entonces no se construye la tool.
4. **`consultarPeriodo`** (renta): parámetros sin determinar. Puede ser innecesario si `buscaDeclVgte` ya cubre el caso.
5. **Los otros valores de `estadoContab`** en el RCV: sólo se verificó `REGISTRO`.
6. **`djconsultarentaui`** (ingresos y agentes retenedores): otra aplicación, sin relevar. **Ojo:** su raíz ejecuta JavaScript que borra las cookies de sesión — inofensivo por HTTP, letal por navegador.

### Se queda en navegador, y está bien

**`vica` (bienes raíces)** usa cola virtual Queue-it, que un cliente HTTP sin JavaScript podría no atravesar. Son 3 llamadas contra 70: no vale forzarlo.

### El F29 de empresa: el camino es autenticar como la empresa, no representarla

**La lista de empresas es nuestra, no del SII.** El usuario del servicio administra un conjunto de empresas y **para cada una tiene su RUT y su clave del SII**. Ese listado se define del lado del servicio; no es un dato que haya que descubrir en el portal ni una autorización que el SII deba conceder.

Eso reencuadra el pendiente. La representación electrónica —el camino que relevaron las spikes de [F29](2026-08-01-f29-declaraciones-contratos.md) y [representación](2026-08-01-representacion-empresa.md)— resolvía el problema de operar varias empresas **desde una sola identidad**. Con credenciales por empresa ese problema no existe: se autentica como la empresa y `propuestaf29ui` valida contra el RUT que la sesión ya es.

Consecuencia práctica: **el F29 de empresa no está bloqueado por un trámite.** No hace falta `getRepresentantes`, ni `authorize/v1/urlApplicacion`, ni resolver el `clientId` o el `code_app` — todo eso era maquinaria para representar a un tercero. El esquema de `propuestaf29ui` ya está verificado; falta ejercitarlo con una sesión de empresa.

Lo que sí queda por resolver, y es la razón real por la que no se construye `sii_f29_*` hoy:

1. **El modelo de credenciales del servidor.** Hoy `env.ts` toma un único juego (`SII_RUT` + `SII_CLAVE` o certificado) y `server.ts` comparte **un** `SessionManager`. Varias empresas con clave propia exigen una credencial por identidad y una sesión por identidad — con el candado que ya existe: dos sesiones simultáneas contra el mismo RUT disparan el bloqueo del SII.
2. **Que eso sea posible.** Es exactamente lo que la migración a HTTP compra y el navegador impide: un Chrome con un solo almacén de cookies no puede sostener dos identidades. Por eso **migrar mipyme a HTTP es prerrequisito del multi-empresa**, no un refactor cosmético.
3. **Custodia.** Guardar claves tributarias de varias empresas es una decisión de seguridad con consecuencias propias, y habilita escritura sobre cada una. Hay que resolverla explícitamente, no heredarla del hecho de que las claves existan.

La spike de representación no se desperdicia: el puente `legacy/bridge2` es genérico y sirve para cualquier aplicación de tercera generación del portal, con la sesión que sea.

### Bloqueado por una decisión sobre datos de terceros (esto sí depende de vos)

**`sii_bhe_emitir` / `sii_bhe_anular`.** Los pasos de lectura del flujo están relevados. Lo que falta:

1. **Qué campos son obligatorios y en qué formato**, y **la forma de la respuesta del paso 3**. El paso 3 previsualiza sin emitir, así que es seguro ejercitarlo — pero necesita **un receptor real**, idealmente propio y con acuerdo previo.
2. **El valor de `estado` para una boleta anulada**: hoy `sii_bhe_list_emitidas` lo infiere de dos señales porque no hay ninguna boleta anulada capturada.
3. **Si `tiempo` es anti-replay.** Mientras no se sepa: propagarlo tal cual, no regenerarlo.

Hasta tener 1, escribir `sii_bhe_emitir` sería inventar el contrato. ([spec](2026-08-01-bhe-emision-contratos.md))

## 4. Supuestos vigentes

Cosas que el proyecto da por ciertas y que romperían cosas si son falsas:

1. **La lista de empresas del servicio es propia, y cada empresa trae sus credenciales.** El usuario administra un conjunto de empresas y tiene el RUT y la clave del SII **de cada una**. No es un dato que el portal deba entregar ni una autorización que el SII deba conceder.

   Eso convive con un hecho verificado y no lo contradice: **cada aplicación del SII tiene su propia noción de autorización** — con la misma cuenta, mipyme lista 5 empresas, el RCV habilita 17, Consultas DTE las mismas 17, el registro de representantes 0. La lección sigue en pie para cualquier listado que devuelva el portal: **ninguna de esas listas es "la lista de empresas del usuario"**, y no son intercambiables entre aplicaciones. Con credenciales por empresa el problema deja de importar para operar, pero sigue importando al interpretar lo que devuelve cada aplicación.
2. **Alcance de solo lectura.** Ningún método de escritura se invoca: `eliminarPublicacionDte` (DTE), `ingresarAceptacionReclamoDocs` (RCV, acepta o reclama documentos con efecto sobre terceros), el paso 4 de emisión de BHE. `sii_mipyme_emitir_dte` es la única excepción y es explícita.
3. **La configuración de hoy es de una sola identidad.** `env.ts` toma un único juego de credenciales y `server.ts` comparte un único `SessionManager`; `SII_EMPRESA_RUT` selecciona la empresa para el camino de navegador. El modelo multi-empresa —una credencial y una sesión por empresa— **todavía no está implementado**, y no es un cambio de configuración sino de arquitectura de sesión.
4. **Los endpoints de PDF** (`createSpecialServiceOperation`, mismo sobre con `responseType: arraybuffer`) están fuera del alcance acordado.
5. **`agent-browser` global** sigue siendo requisito de instalación, y va a seguir siéndolo mientras mipyme y bienes raíces no migren.
6. **Los totales que declara el SII no reconcilian con sus propias filas.** En un período real, `totMntNeto` daba 197.733.705 y la suma del detalle 163.060.976. El parser suma las filas; el declarado se expone aparte. Una fixture conserva la discrepancia a propósito.

## 5. Qué depende de vos, corto

1. **Cómo se custodian las claves de las empresas administradas.** Es la decisión que habilita el multi-empresa entero, y es de seguridad antes que de código: dónde viven las credenciales, quién las provee, y qué alcance de escritura se acepta al tenerlas.
2. **Decidir el receptor real para ejercitar el paso 3 de BHE** — desbloquea `sii_bhe_emitir`.
3. **Confirmar el orden**: la migración de mipyme a HTTP es prerrequisito del multi-empresa y el trabajo más grande que se puede empezar hoy sin depender de nada externo. Los pendientes de verificación (1, 3–6 de la sección 3) son más chicos y no compiten.

Todo lo demás de la sección 3 se puede avanzar sin consultarte.
