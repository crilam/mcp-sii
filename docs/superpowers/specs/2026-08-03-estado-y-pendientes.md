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
2. **Migrar el portal mipyme a HTTP.** Es la deuda grande de navegador (~70 llamadas) y no está relevada. Sin ella no hay aislamiento por identidad, o sea no hay servicio multi-entidad. `getEmpContribuyente` ya mostró que la selección de empresa probablemente desaparece en el camino HTTP.
3. **`buscaObservacion` (renta F22)** devolvió `respCod: 2` contra una declaración limpia, y eso no distingue "sin observaciones" de "parámetros incorrectos". Requiere una declaración **observada** para verificar. Hasta entonces no se construye la tool.
4. **`consultarPeriodo`** (renta): parámetros sin determinar. Puede ser innecesario si `buscaDeclVgte` ya cubre el caso.
5. **Los otros valores de `estadoContab`** en el RCV: sólo se verificó `REGISTRO`.
6. **`djconsultarentaui`** (ingresos y agentes retenedores): otra aplicación, sin relevar. **Ojo:** su raíz ejecuta JavaScript que borra las cookies de sesión — inofensivo por HTTP, letal por navegador.

### Se queda en navegador, y está bien

**`vica` (bienes raíces)** usa cola virtual Queue-it, que un cliente HTTP sin JavaScript podría no atravesar. Son 3 llamadas contra 70: no vale forzarlo.

### Bloqueado por un trámite (esto sí depende de vos)

**El F29 de empresa.** El esquema de `propuestaf29ui` está verificado y el acceso a la aplicación de representantes también. El bloqueo es de **registro**: `getRepresentantes` devolvió `total: 0` — el RUT probado no tiene ninguna empresa inscrita como representación electrónica. Opera esas empresas por otros mecanismos (la lista de mipyme, la autorización del RCV), pero no como representante electrónico registrado.

Eso explica sin misterio por qué el RCV funciona y la propuesta F29 no: el RCV valida contra su propia lista de autorizadas; la propuesta F29, contra el RUT que la sesión representa — hoy sólo el propio.

**Inscribir la representación es necesario, no necesariamente suficiente.** Después del trámite quedan tres cosas técnicas sin resolver, de tamaño desconocido hasta poder intentarlas: ejercitar `authorize/v1/urlApplicacion`, determinar de dónde sale el `clientId` que ese POST exige, y cuál es el `code_app` de la propuesta F29.

Mientras eso no esté, el cruce "lo registrado contra lo declarado" no se puede completar: el lado registrado (RCV) funciona hoy, el declarado no. **No construir `sii_f29_*` todavía** — sólo serviría para el RUT de la persona autenticada, que es justamente quien no declara F29. ([spec F29](2026-08-01-f29-declaraciones-contratos.md), [spec representación](2026-08-01-representacion-empresa.md))

La alternativa —autenticar con la clave tributaria de cada empresa— sigue existiendo, pero no es el camino barato: es un atajo alrededor de un trámite, con custodia de credenciales de terceros y alcance de escritura como consecuencia.

### Bloqueado por una decisión sobre datos de terceros (también depende de vos)

**`sii_bhe_emitir` / `sii_bhe_anular`.** Los pasos de lectura del flujo están relevados. Lo que falta:

1. **Qué campos son obligatorios y en qué formato**, y **la forma de la respuesta del paso 3**. El paso 3 previsualiza sin emitir, así que es seguro ejercitarlo — pero necesita **un receptor real**, idealmente propio y con acuerdo previo.
2. **El valor de `estado` para una boleta anulada**: hoy `sii_bhe_list_emitidas` lo infiere de dos señales porque no hay ninguna boleta anulada capturada.
3. **Si `tiempo` es anti-replay.** Mientras no se sepa: propagarlo tal cual, no regenerarlo.

Hasta tener 1, escribir `sii_bhe_emitir` sería inventar el contrato. ([spec](2026-08-01-bhe-emision-contratos.md))

## 4. Supuestos vigentes

Cosas que el proyecto da por ciertas y que romperían cosas si son falsas:

1. **Cada aplicación del SII tiene su propia noción de autorización.** Verificado tres veces con la misma cuenta: mipyme lista 5 empresas, el RCV habilita 17, Consultas DTE devuelve las mismas 17, el registro de representantes 0. **No existe "la lista de empresas del usuario".**
2. **Alcance de solo lectura.** Ningún método de escritura se invoca: `eliminarPublicacionDte` (DTE), `ingresarAceptacionReclamoDocs` (RCV, acepta o reclama documentos con efecto sobre terceros), el paso 4 de emisión de BHE. `sii_mipyme_emitir_dte` es la única excepción y es explícita.
3. **`SII_EMPRESA_RUT` sigue existiendo para el camino de navegador.** En el camino HTTP la empresa es parámetro de cada consulta, así que no hace falta — pero mientras `mipyme.ts` viva en el navegador, la variable importa.
4. **Los endpoints de PDF** (`createSpecialServiceOperation`, mismo sobre con `responseType: arraybuffer`) están fuera del alcance acordado.
5. **`agent-browser` global** sigue siendo requisito de instalación, y va a seguir siéndolo mientras mipyme y bienes raíces no migren.
6. **Los totales que declara el SII no reconcilian con sus propias filas.** En un período real, `totMntNeto` daba 197.733.705 y la suma del detalle 163.060.976. El parser suma las filas; el declarado se expone aparte. Una fixture conserva la discrepancia a propósito.

## 5. Qué depende de vos, corto

1. **Inscribir la representación electrónica en el SII** — desbloquea el F29 de empresa (y después queda trabajo técnico de tamaño desconocido).
2. **Decidir el receptor real para ejercitar el paso 3 de BHE** — desbloquea `sii_bhe_emitir`.
3. **Confirmar si migrar el portal mipyme es la prioridad** frente a los pendientes de verificación. Es el trabajo más grande que se puede empezar hoy sin depender de nada externo, y es lo único que destraba el aislamiento por identidad.

Todo lo demás de la sección 3 se puede avanzar sin consultarte.
