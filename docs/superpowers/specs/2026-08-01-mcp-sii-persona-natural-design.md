# Diseño: ampliación del MCP del SII hacia persona natural

Fecha: 2026-08-01
Estado: propuesto

## Contexto

El MCP cubre hoy tres áreas —DTE, mipyme (facturación gratuita) y bienes raíces— de las 20 categorías que expone el portal del SII. La cobertura es empresa-céntrica: casi todo depende de `SII_EMPRESA_RUT` y de la selección de empresa.

Un recorrido completo del portal autenticado como persona natural (solo GET, sin enviar ni modificar datos) mostró que la superficie de persona natural es amplia y está prácticamente sin cubrir: boletas de honorarios, renta F22, situación tributaria, carpeta tributaria, contribuciones y tasación de vehículos.

El mapa completo del portal quedó versionado en `docs/sii-portal-map.md` (árbol de 646 nodos) y `docs/sii-portal-menu.json` (datos crudos).

### Hallazgos del recorrido

El portal publica su menú entero en `https://zeusr.sii.cl/admin/js/tramites_misii.js`, como un arreglo `menuSOL` de 646 nodos con `{id, nivel, padre, texto, url}`. De ahí salen 457 URLs de aplicación real (el resto son páginas informativas bajo `www.sii.cl/servicios_online/`).

Se sondearon 171 endpoints de consulta con sesión de certificado: 128 devolvieron contenido autenticado y ninguno rebotó al login. La sesión de persona natural cubre prácticamente todo el portal.

Tres hallazgos determinan el diseño:

1. **Todo el portal responde por HTTP directo con las cookies del certificado.** No hace falta navegador. Las apps modernas (`www4.sii.cl/*ui/`) son AngularJS con backends REST JSON; los módulos antiguos (`loa.sii.cl`, `zeus.sii.cl`) son CGIs con formularios.

2. **Trampa de logout.** La raíz de `https://www4.sii.cl/djconsultarentaui/` responde con JavaScript que borra las cookies de sesión (`TOKEN`, `NETSCAPE_LIVEWIRE.locexp`, `.lms`, `.sec`). Con un cliente HTTP no afecta, porque no ejecuta JS. Con `agent-browser` **desloguea la sesión**. Como el SII bloquea por exceso de sesiones simultáneas, esto es un riesgo real del enfoque actual, que es 100 % navegador.

3. **Las APIs REST rechazan GET.** Devuelven `405` vía `MethodNotAllowedException`; son POST aunque sean consultas de lectura. Y responden `application/json;charset=ISO-8859-1`: decodificar como UTF-8 corrompe todo texto con tilde.

## Decisiones

| Decisión | Elección |
|---|---|
| Foco | Persona natural primero |
| Alcance | Lectura, más emisión y anulación de BHE |
| Transporte | HTTP directo (`SiiHttpClient`), con navegador como excepción acotada |
| Guardrail de escritura | Dry-run con confirmación explícita |

La excepción de transporte no es una puerta abierta: aplica solo donde se demuestre que HTTP no pasa —hoy, el candidato conocido es la cola virtual de `vica`— y no releva de una sola sesión compartida. Ver Riesgos, puntos 1 y 2.

## Arquitectura

### `src/http.ts` — `SiiHttpClient`

Transporte nuevo, y pieza central del diseño. Toma la autenticación por certificado que hoy vive dentro de `session.ts` y la expone como cliente reutilizable.

Responsabilidades:

- Mantener el cookie jar de la sesión autenticada por certificado (TLS mutuo).
- `get(url)`, `postJson(url, body)`, `postForm(url, campos)`.
- Decodificar respuestas como ISO-8859-1 salvo que el `Content-Type` diga otra cosa.
- Detectar sesión caída y reautenticar una vez, de forma transparente.
- Detectar el límite de sesiones del SII (`01.01.190.500.720.27`) y lanzarlo como error tipado, no como fallo genérico.

Interfaz mínima, sin conocimiento de ningún dominio del SII. Los scrapers reciben un `SiiHttpClient` y no saben cómo se autenticó.

La autenticación en sí se extrae de `SessionManager.loginWithCert()` a un módulo propio (`src/auth/certificado.ts`): resolver el binario OpenSSL 3.x, extraer cert y clave del `.pfx`, hacer el POST al CGI de autenticación, parsear el cookie jar y fijar la cookie `locexp`. Esa lógica ya está probada y no cambia de comportamiento; solo cambia de lugar para que HTTP y navegador la compartan.

### `SessionManager`

Se refactoriza para separar dos cosas que hoy están entrelazadas:

- **Autenticación de persona** — ya existe como `authenticateOnly()`. Es lo único que necesitan las tools nuevas.
- **Selección de empresa** — sigue siendo requisito de las tools de mipyme y DTE.

Ninguna tool de persona natural debe exigir `SII_EMPRESA_RUT`.

`SessionManager` es además **el único dueño de la sesión del proceso**. Con dos transportes conviviendo, esto deja de ser un detalle: es el requisito que impide abrir dos sesiones simultáneas contra el SII y disparar su bloqueo. Un solo cookie jar, del que `SiiHttpClient` lee y desde el que se inyectan las cookies al navegador. Detalle y mitigación en Riesgos, punto 2.

### Scrapers y tools

Un módulo por dominio, siguiendo el patrón actual: `src/scrapers/<dominio>.ts` con el parsing y los tipos, `src/tools/<dominio>.ts` con el registro en el `McpServer`. Archivos chicos y enfocados; cuando un dominio crece, se parte.

Módulos nuevos: `bhe`, `renta`, `situacion`, `contribuciones`, `vehiculos`, `persona`.

`src/browser.ts` y los scrapers existentes quedan como están. No se migran en este trabajo: siguen funcionando y migrarlos es un cambio aparte, sin valor inmediato para el usuario.

## Estado de verificación

Las URLs de este spec provienen del árbol `menuSOL`, así que todas son reales. Lo que **no** es uniforme es cuánto se probó de cada una. Cada tool lleva un estado:

| Estado | Significado |
|---|---|
| **verificado** | Se ejecutó en vivo con sesión de certificado y devolvió datos. El contrato es conocido. |
| **inferido** | La URL es correcta y el módulo respondió autenticado, pero el contrato exacto (parámetros, formato de respuesta) no se probó. |
| **por descubrir** | Solo se conoce la pantalla. El endpoint real y su contrato requieren trabajo de descubrimiento. |

Un estado no es una estimación de dificultad, sino de **incertidumbre**. Las tools "por descubrir" pueden resultar triviales o imposibles, y no se sabrá hasta explorarlas.

## Fases

La Fase 0 es una spike: no entrega tools, reduce incertidumbre. De la 1 a la 5, cada fase entrega valor por sí sola y puede cortarse sin dejar nada a medias.

El orden de la 1 a la 5 refleja valor para persona natural, no confianza técnica. Son casi inversos: la Fase 5 es la mejor verificada y la más barata, la Fase 1 la de mayor valor y mayor incertidumbre. Por eso existe la Fase 0 — y por eso, si la spike falla, el orden se reordena en favor de lo verificado.

### Fase 0 — Spike de descubrimiento de BHE

**Precede a todo lo demás y no entrega tools.** Su único objetivo es eliminar la incertidumbre más cara del plan antes de comprometerse con el orden de fases.

El recorrido confirmó que el menú de BHE carga autenticado y que el SII inyecta `rut_arrastre` server-side. Pero no se identificó el CGI que ejecuta la consulta: `TMBCOC_ConsultasContrib.js` (18 KB) no contiene ninguna referencia a `.cgi`, así que el destino se arma en otro lado. Del flujo de emisión no se verificó nada.

La spike debe responder tres preguntas, en este orden:

1. **¿Cuál es el CGI de consulta y qué parámetros recibe?** Interceptar el POST real del formulario de informes.
2. **¿La emisión tiene un paso de validación separado del de emisión?** De esto depende que el guardrail de dry-run sea implementable. `TMBECN_ValidaTimbrajeContrib.cgi` sugiere que sí, pero el nombre no es evidencia.
3. **¿El flujo de emisión mantiene estado server-side entre pasos?** Si lo hace, el cliente HTTP debe preservar el orden y los tokens intermedios.

Se resuelve observando el tráfico del portal con `agent-browser` durante una consulta real —no emitiendo nada— y capturando fixtures en el paso.

**Criterio de salida:** una consulta de BHE emitidas ejecutada por HTTP directo, devolviendo datos. Si la spike muestra que la emisión es un POST atómico sin validación previa, se aplica el fallback documentado en Guardrails.

**Si la spike falla**, el orden de fases cambia: la Fase 2 (renta F22, la única ya verificada de punta a punta) pasa al frente y BHE se reevalúa. Comprometerse con BHE primero sin esta spike es una apuesta sobre el módulo menos explorado del plan.

### Fase 1 — Boletas de honorarios electrónicas

El hueco más grande para persona natural. Módulo antiguo: CGIs en `https://loa.sii.cl/cgi_IMT/` con formularios POST y respuesta HTML.

Los endpoints de la tabla son las **pantallas de menú** verificadas, no los CGI de consulta: esos los determina la Fase 0. La fase no puede planificarse en detalle antes de que la spike cierre.

| Tool | Descripción | Pantalla | Estado |
|---|---|---|---|
| `sii_bhe_list_emitidas` | Boletas emitidas en un rango de fechas | `TMBCOC_MenuConsultasContrib.cgi` | por descubrir |
| `sii_bhe_list_recibidas` | Boletas recibidas | `TMBCOC_MenuConsultasContribRec.cgi` | por descubrir |
| `sii_bhe_resumen` | Informe anual, mensual o diario | mismo formulario, modo según período | por descubrir |
| `sii_bhe_emitir` | Emite una BHE | `TMBECN_ValidaTimbrajeContrib.cgi?modo=1` | por descubrir |
| `sii_bhe_anular` | Anula una BHE emitida | `TMBANU_PrevalidaAnulacion.cgi` | por descubrir |

Lo verificado: las cinco pantallas responden autenticadas, y la de informes expone selectores de año, mes y día con el RUT ya inyectado por el servidor. Nada más.

Las boletas de terceros (BTE) viven en `https://zeus.sii.cl/cvc_cgi/bte/` (`bte_indiv_cons?1` emitidas, `?2` recibidas). Quedan fuera de esta fase: son un flujo distinto y de menor uso para persona natural.

`sii_bhe_emitir` recibe receptor (RUT y DV), descripción del servicio, monto bruto y si corresponde retención. Devuelve el folio asignado.

### Fase 2 — Renta F22

Las APIs REST ya verificadas. Base: `https://www4.sii.cl/consultaestadof22ui/services/data/facadeService/`, todas POST con cuerpo JSON.

| Tool | Descripción | Endpoint | Estado |
|---|---|---|---|
| `sii_renta_estado_declaracion` | Estado de la declaración de un año tributario | `buscaDeclVgte`, `getEstadoFolio` | verificado |
| `sii_renta_get_f22` | Formulario 22 completo o compacto | `f22Completo`, `f22Compacto` | inferido |
| `sii_renta_observaciones` | Observaciones y su documentación | `buscaObservacion`, `buscarDocumentacion` | inferido |
| `sii_renta_ingresos_y_retenedores` | Ingresos declarados por terceros | `djconsultarentaui` | por descubrir |

Lo verificado: `buscaDeclVgte` responde `200 application/json` con cuerpo `{"data":null,"respCod":2,...}` ante un POST vacío, y rechaza GET con 405. Los demás endpoints de `facadeService` están declarados en el bundle y viven bajo la misma base, pero no se ejecutaron uno por uno. `djconsultarentaui` es una aplicación distinta cuya base REST no se exploró.

Los esquemas exactos de payload se extraen del bundle minificado (`app.full.*.min.js`), que declara los endpoints y sus parámetros. El sondeo confirmó que responden JSON autenticado; con cuerpo vacío devuelven `{"respCod":2}` y con campos incorrectos un error de formato explícito, así que el esquema es descubrible iterando.

`sii_renta_ingresos_y_retenedores` toca `djconsultarentaui`, el módulo con la trampa de logout. Por HTTP directo es seguro —no se ejecuta el JS— pero el cliente debe verificar que la sesión sigue viva después de llamarlo, para no dejar fallas silenciosas si el SII cambia el mecanismo.

Los endpoints de PDF (`f22Compacto/pdf64`, `certificadoSolemne/pdf`) quedan fuera: devuelven binario y el valor para un agente es marginal frente al JSON.

### Fase 3 — Situación tributaria

| Tool | Descripción | Endpoint | Estado |
|---|---|---|---|
| `sii_situacion_tributaria` | Situación tributaria de un RUT (propio o de un tercero) | `https://www2.sii.cl/stc/noauthz` | inferido |
| `sii_carpeta_tributaria_historial` | Historial de carpetas tributarias regulares emitidas | `https://www2.sii.cl/carpetatributaria/cteregular` | inferido |
| `sii_estado_cumplimiento` | Estado de cumplimiento de obligaciones (Ley 21.713) | `https://misiir.sii.cl/cgi_misii/siihome.cgi` | verificado |

`sii_estado_cumplimiento` es el caso mejor sustentado de esta fase: el home de Mi SII ya devuelve el bloque de cumplimiento tributario en el HTML servido, y se leyó en el recorrido. Solo falta el parser.

La *generación* de carpeta tributaria (`generarcteregular`) queda fuera: crea un documento y entrega acceso a terceros, así que es escritura, y el alcance acordado limita la escritura a BHE. Se consulta el historial, no se emiten carpetas nuevas.

`sii_situacion_tributaria` apunta a `/stc/noauthz`, que por su propio nombre no requiere autorización. Se resuelve **sin pasar por el cliente autenticado**: enrutarla por la sesión consumiría el recurso más escaso del sistema sin necesidad. Es la única tool del plan que no toca la sesión.

### Fase 4 — Patrimonio

Complementa el tool de bienes raíces que ya existe. **Es la fase con mayor incertidumbre del plan**, por dos razones distintas que se detallan abajo.

| Tool | Descripción | Pantalla | Estado |
|---|---|---|---|
| `sii_bbrr_contribuciones` | Historial de pagos de contribuciones de un rol | `cuotaanualbienesraicespubinternetui/#!/HistorialRolPago` | por descubrir |
| `sii_bbrr_certificado_avaluo` | Certificado de avalúo fiscal | `www2.sii.cl/vica/Menu/CertificadosAvaluoCC` | por descubrir |
| `sii_bbrr_antecedentes` | Antecedentes de un bien raíz | `www2.sii.cl/vica/Menu/AntecedentesBienRaiz` | por descubrir |
| `sii_vehiculo_tasacion` | Tasación fiscal de un vehículo | `vehiculospubui/#/searchtasacion` | por descubrir |

**Las URLs con `#` no son endpoints, son rutas de cliente.** Todo lo que sigue al `#` nunca llega al servidor: son pantallas de una SPA. Lo único que el servidor ve es `https://www4.sii.cl/cuotaanualbienesraicespubinternetui/` y `https://www4.sii.cl/vehiculospubui/`. Los endpoints REST reales hay que extraerlos del bundle minificado de cada aplicación, igual que se hizo con `consultaestadof22ui` en el recorrido. Ese trabajo de descubrimiento **es parte de esta fase**, y no está hecho.

Las dos tools sobre `vica` tienen un riesgo adicional y de otra naturaleza: **cola virtual**. El scraper de bienes raíces existente documenta que el portal `vica` usa Queue-it (`src/scrapers/bienesRaices.ts:51`), y por eso está implementado con navegador y espera de 30 segundos. Una cola virtual es precisamente lo que un cliente HTTP sin ejecución de JavaScript puede no atravesar. Estas dos tools son las candidatas más probables a necesitar el fallback a navegador descrito en Riesgos.

El rol semestral de contribuciones (`https://www4.sii.cl/rolreavaluointernetui/`) queda fuera: es una nómina comunal masiva, no información del contribuyente.

### Fase 5 — Datos personales

| Tool | Descripción | Endpoint | Estado |
|---|---|---|---|
| `sii_persona_datos` | Nombre, RUT, domicilio, correos, direcciones, fecha de inicio de actividades | `https://misiir.sii.cl/cgi_misii/siihome.cgi` | verificado |
| `sii_persona_historial_autenticaciones` | Historial de autenticaciones y de cambios de clave tributaria | `https://misiir.sii.cl/cgi_misii/siihome.cgi` | inferido |

Ambas salen del home de Mi SII, que ya devuelve estos bloques en el HTML servido. El recorrido leyó directamente los datos del contribuyente, direcciones, correos e inicio de actividades, así que `sii_persona_datos` solo necesita parser. El bloque de historial de clave aparece enunciado en la misma página, pero su contenido no se inspeccionó: puede cargarse aparte.

Una sola petición alimenta las dos tools, así que comparten parser. Es la fase más barata del plan y la de menor riesgo.

## Guardrails de escritura

`sii_bhe_emitir` y `sii_bhe_anular` reciben un parámetro `confirmar`, con default `false`.

Con `confirmar: false` la tool valida los datos contra el SII —receptor existe, timbraje disponible, montos y retención calculados— y devuelve el preview del documento **sin emitirlo**. Con `confirmar: true` ejecuta la emisión.

La descripción de cada tool declara explícitamente que es un acto tributario real e irreversible. El objetivo es que una emisión nunca ocurra por una interpretación equivocada del agente: exige dos invocaciones deliberadas.

La anulación de BHE tiene además efecto sobre el receptor, que puede confirmarla o rechazarla. La tool lo indica en su respuesta para que no se lea como una operación cerrada.

### Si el SII no permite validar sin emitir

El diseño anterior asume que existe un paso de validación separado del de emisión. Eso **no está verificado**: lo resuelve la Fase 0. Si resulta que emisión y validación son un único POST atómico, se aplica este fallback, en orden de preferencia:

1. **Validación local más consulta de solo lectura.** El dry-run valida lo verificable sin escribir —RUT y DV del receptor, montos, cálculo de retención, formato— y consulta el timbraje disponible con una llamada de lectura. Devuelve el preview advirtiendo explícitamente que la validación es parcial y que el SII puede rechazar la emisión.
2. **Si ni siquiera eso es posible**, `sii_bhe_emitir` no se entrega en la Fase 1 y se documenta por qué. El alcance de lectura se entrega igual.

Lo que **no** se hace es emitir de verdad para "probar" y después anular. Una BHE emitida y anulada deja rastro en el SII y notifica al receptor.

## Errores

Errores tipados y accionables, siguiendo el criterio que ya usa el repo de explicar la causa y el remedio:

- **Sesión expirada** — reautenticación transparente, un solo reintento.
- **Límite de sesiones excedido** — mensaje con el código del SII (`01.01.190.500.720.27`) y la indicación de cerrar sesión con `sii_cerrar_sesion`.
- **Certificado inválido o vencido** — distinguir del rechazo de credenciales; el CGI responde 200 con un `alert()` de JavaScript, que ya se detecta hoy.
- **Sin datos para el período** — resultado vacío legítimo, no error. Debe distinguirse de una página que no cargó, que sí es error.

Esa última distinción es la que ya causó problemas en los scrapers actuales y está documentada en los comentarios de `bienesRaices.ts`. El cliente HTTP la hace más fácil: un `200` con cuerpo parseable y cero filas es un vacío legítimo; un cuerpo que no matchea la estructura esperada es un error.

## Riesgos y supuestos

Los cuatro riesgos que pueden invalidar partes del diseño, con su mitigación.

### 1. Queue-it puede bloquear al cliente HTTP

**Supuesto en riesgo:** que HTTP directo sirva para *todo* el portal.

El portal `vica` usa cola virtual (Queue-it), documentado en `src/scrapers/bienesRaices.ts:51`. Una cola virtual emite un token tras ejecutar JavaScript; un cliente HTTP puede quedar fuera. Afecta a las dos tools de `vica` en la Fase 4.

**Mitigación:** se prueba `vica` por HTTP antes de escribir esas tools. Si la cola bloquea, esas dos tools —y solo esas— usan el navegador, que es el patrón que ya funciona hoy. `SiiHttpClient` y `Browser` comparten sesión (ver riesgo 2), así que convivir no cuesta una sesión extra. Es la excepción prevista a la decisión de transporte, no su refutación: el resto del portal ya se probó por HTTP.

### 2. Dos transportes pueden abrir dos sesiones

**Supuesto en riesgo:** que compartir el módulo de autenticación baste.

Compartir `src/auth/certificado.ts` no garantiza compartir la *sesión*. Si `SiiHttpClient` y `Browser` autentican por separado, el proceso abre dos sesiones simultáneas contra el SII — exactamente lo que dispara el bloqueo `01.01.190.500.720.27` que este diseño busca evitar. El riesgo es peor que hoy, porque hoy hay un solo transporte.

**Mitigación, y es requisito de diseño, no una recomendación:** existe **una sola sesión por proceso**, con un único cookie jar, del que ambos transportes leen y al que ambos escriben. `SessionManager` es su dueño. El cliente HTTP obtiene las cookies de ahí, y la inyección al navegador (`document.cookie`) parte del mismo origen. Un test debe verificar que autenticar por ambos caminos produce una sola autenticación.

### 3. El dry-run puede no ser implementable

**Supuesto en riesgo:** que el SII permita validar una BHE sin emitirla.

Sin verificar. Lo resuelve la Fase 0, y el fallback está en Guardrails.

### 4. Los contratos REST no están documentados

**Supuesto en riesgo:** que los esquemas de payload sean descubribles en tiempo razonable.

Los endpoints se extraen de bundles minificados. En el recorrido, `consultaestadof22ui` respondió `{"respCod":2}` con cuerpo vacío y un error de formato explícito con campos incorrectos, lo que sugiere que iterar funciona. Pero es una muestra de una aplicación, y cada SPA es un caso propio.

**Mitigación:** cada fase que dependa de descubrir contratos empieza por ese trabajo y se replantea si no cierra. Los estados "por descubrir" de las tablas marcan exactamente dónde aplica.

## Tests

Fixtures capturadas del portal —HTML de los CGI, JSON de las APIs REST— guardadas en `tests/fixtures/`. Los tests de parsing corren contra las fixtures, sin red, con el `jest` que ya está configurado.

**Toda fixture se anonimiza antes de versionarse.** Las respuestas del SII contienen datos personales reales: RUT, nombre, domicilio, correos, ingresos, propiedades, montos de boletas y receptores. Este repositorio tiene licencia y PRs, así que una fixture cruda es una filtración.

La anonimización reemplaza RUT por valores de prueba con DV válido, nombres y direcciones por ficticios, y montos por valores redondos, **preservando la estructura y el largo de los campos** —el parsing depende de eso, y un reemplazo descuidado hace que los tests validen un formato que no existe. Los receptores de BHE se sustituyen igual: son terceros que no participan de esta decisión.

El repositorio incorpora un chequeo que rechaza fixtures con RUT del titular o con patrones de RUT chileno válido fuera del rango de prueba.

Cada scraper nuevo lleva tests de: parsing del caso con datos, parsing del caso vacío, y detección de respuesta corrupta o no autenticada.

`SiiHttpClient` se testea con un transporte inyectado, verificando decodificación ISO-8859-1, reautenticación ante sesión caída y mapeo de errores tipados.

Las tools de escritura llevan test explícito de que con `confirmar: false` no se emite nada.

## Fuera de alcance

- Migrar los scrapers existentes (mipyme, DTE, bienes raíces) a HTTP. Funcionan; migrarlos es un trabajo aparte.
- Envío de declaraciones (F22, F29, declaraciones juradas). Riesgo desproporcionado para el valor.
- Boletas de terceros (BTE), descarga de PDF, y las 14 categorías empresa-céntricas restantes del portal.
