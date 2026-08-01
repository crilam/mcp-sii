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
| Transporte | HTTP directo (`SiiHttpClient`) |
| Guardrail de escritura | Dry-run con confirmación explícita |

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

### Scrapers y tools

Un módulo por dominio, siguiendo el patrón actual: `src/scrapers/<dominio>.ts` con el parsing y los tipos, `src/tools/<dominio>.ts` con el registro en el `McpServer`. Archivos chicos y enfocados; cuando un dominio crece, se parte.

Módulos nuevos: `bhe`, `renta`, `situacion`, `contribuciones`, `vehiculos`, `persona`.

`src/browser.ts` y los scrapers existentes quedan como están. No se migran en este trabajo: siguen funcionando y migrarlos es un cambio aparte, sin valor inmediato para el usuario.

## Fases

Cada fase entrega valor por sí sola y puede cortarse sin dejar nada a medias.

### Fase 1 — Boletas de honorarios electrónicas

El hueco más grande para persona natural. Módulo antiguo: CGIs en `https://loa.sii.cl/cgi_IMT/` con formularios POST y respuesta HTML. Se confirmó sesión activa: el SII inyecta `rut_arrastre` server-side en la página.

| Tool | Descripción | Endpoint base |
|---|---|---|
| `sii_bhe_list_emitidas` | Boletas emitidas en un rango de fechas | `TMBCOC_MenuConsultasContrib.cgi` |
| `sii_bhe_list_recibidas` | Boletas recibidas | `TMBCOC_MenuConsultasContribRec.cgi` |
| `sii_bhe_resumen` | Informe anual, mensual o diario | mismo formulario, modo según período |
| `sii_bhe_emitir` | Emite una BHE | `TMBECN_ValidaTimbrajeContrib.cgi?modo=1` |
| `sii_bhe_anular` | Anula una BHE emitida | `TMBANU_PrevalidaAnulacion.cgi` |

Las boletas de terceros (BTE) viven en `https://zeus.sii.cl/cvc_cgi/bte/` (`bte_indiv_cons?1` emitidas, `?2` recibidas). Quedan fuera de esta fase: son un flujo distinto y de menor uso para persona natural.

`sii_bhe_emitir` recibe receptor (RUT y DV), descripción del servicio, monto bruto y si corresponde retención. Devuelve el folio asignado.

### Fase 2 — Renta F22

Las APIs REST ya verificadas. Base: `https://www4.sii.cl/consultaestadof22ui/services/data/facadeService/`, todas POST con cuerpo JSON.

| Tool | Descripción | Endpoint |
|---|---|---|
| `sii_renta_estado_declaracion` | Estado de la declaración de un año tributario | `buscaDeclVgte`, `getEstadoFolio` |
| `sii_renta_get_f22` | Formulario 22 completo o compacto | `f22Completo`, `f22Compacto` |
| `sii_renta_observaciones` | Observaciones y su documentación | `buscaObservacion`, `buscarDocumentacion` |
| `sii_renta_ingresos_y_retenedores` | Ingresos declarados por terceros | `djconsultarentaui` |

Los esquemas exactos de payload se extraen del bundle minificado (`app.full.*.min.js`), que declara los endpoints y sus parámetros. El sondeo confirmó que responden JSON autenticado; con cuerpo vacío devuelven `{"respCod":2}` y con campos incorrectos un error de formato explícito, así que el esquema es descubrible iterando.

`sii_renta_ingresos_y_retenedores` toca `djconsultarentaui`, el módulo con la trampa de logout. Por HTTP directo es seguro —no se ejecuta el JS— pero el cliente debe verificar que la sesión sigue viva después de llamarlo, para no dejar fallas silenciosas si el SII cambia el mecanismo.

Los endpoints de PDF (`f22Compacto/pdf64`, `certificadoSolemne/pdf`) quedan fuera: devuelven binario y el valor para un agente es marginal frente al JSON.

### Fase 3 — Situación tributaria

| Tool | Descripción | Endpoint |
|---|---|---|
| `sii_situacion_tributaria` | Situación tributaria de un RUT (propio o de un tercero) | `https://www2.sii.cl/stc/noauthz` |
| `sii_carpeta_tributaria_historial` | Historial de carpetas tributarias regulares emitidas | `https://www2.sii.cl/carpetatributaria/cteregular` |
| `sii_estado_cumplimiento` | Estado de cumplimiento de obligaciones (Ley 21.713) | `https://misiir.sii.cl/cgi_misii/siihome.cgi` |

`sii_estado_cumplimiento` se parsea del home de Mi SII, que ya devuelve el bloque de cumplimiento tributario en el HTML servido.

La *generación* de carpeta tributaria (`generarcteregular`) queda fuera: crea un documento y entrega acceso a terceros, así que es escritura, y el alcance acordado limita la escritura a BHE. Se consulta el historial, no se emiten carpetas nuevas.

`sii_situacion_tributaria` usa el endpoint público de consulta de terceros, que sirve igual para el RUT propio. No requiere sesión, pero se mantiene dentro del cliente autenticado por uniformidad.

### Fase 4 — Patrimonio

Complementa el tool de bienes raíces que ya existe.

| Tool | Descripción | Endpoint |
|---|---|---|
| `sii_bbrr_contribuciones` | Historial de pagos de contribuciones de un rol | `https://www4.sii.cl/cuotaanualbienesraicespubinternetui/#!/HistorialRolPago` |
| `sii_bbrr_certificado_avaluo` | Certificado de avalúo fiscal | `https://www2.sii.cl/vica/Menu/CertificadosAvaluoCC` |
| `sii_bbrr_antecedentes` | Antecedentes de un bien raíz | `https://www2.sii.cl/vica/Menu/AntecedentesBienRaiz` |
| `sii_vehiculo_tasacion` | Tasación fiscal de un vehículo | `https://www4.sii.cl/vehiculospubui/#/searchtasacion` |

`sii_bbrr_antecedentes` cuelga del mismo portal `vica` que ya usa el scraper de bienes raíces existente, así que comparte el patrón de acceso.

El rol semestral de contribuciones (`https://www4.sii.cl/rolreavaluointernetui/`) queda fuera: es una nómina comunal masiva, no información del contribuyente.

### Fase 5 — Datos personales

| Tool | Descripción | Endpoint |
|---|---|---|
| `sii_persona_datos` | Nombre, RUT, domicilio, correos, direcciones, fecha de inicio de actividades | `https://misiir.sii.cl/cgi_misii/siihome.cgi` |
| `sii_persona_historial_autenticaciones` | Historial de autenticaciones y de cambios de clave tributaria | `https://misiir.sii.cl/cgi_misii/siihome.cgi` |

Ambas salen del home de Mi SII, que ya devuelve estos bloques en el HTML servido: datos del contribuyente, direcciones vigentes, correos, inicio de actividades e historial de clave. Una sola petición alimenta las dos tools, así que comparten parser.

## Guardrails de escritura

`sii_bhe_emitir` y `sii_bhe_anular` reciben un parámetro `confirmar`, con default `false`.

Con `confirmar: false` la tool valida los datos contra el SII —receptor existe, timbraje disponible, montos y retención calculados— y devuelve el preview del documento **sin emitirlo**. Con `confirmar: true` ejecuta la emisión.

La descripción de cada tool declara explícitamente que es un acto tributario real e irreversible. El objetivo es que una emisión nunca ocurra por una interpretación equivocada del agente: exige dos invocaciones deliberadas.

La anulación de BHE tiene además efecto sobre el receptor, que puede confirmarla o rechazarla. La tool lo indica en su respuesta para que no se lea como una operación cerrada.

## Errores

Errores tipados y accionables, siguiendo el criterio que ya usa el repo de explicar la causa y el remedio:

- **Sesión expirada** — reautenticación transparente, un solo reintento.
- **Límite de sesiones excedido** — mensaje con el código del SII (`01.01.190.500.720.27`) y la indicación de cerrar sesión con `sii_cerrar_sesion`.
- **Certificado inválido o vencido** — distinguir del rechazo de credenciales; el CGI responde 200 con un `alert()` de JavaScript, que ya se detecta hoy.
- **Sin datos para el período** — resultado vacío legítimo, no error. Debe distinguirse de una página que no cargó, que sí es error.

Esa última distinción es la que ya causó problemas en los scrapers actuales y está documentada en los comentarios de `bienesRaices.ts`. El cliente HTTP la hace más fácil: un `200` con cuerpo parseable y cero filas es un vacío legítimo; un cuerpo que no matchea la estructura esperada es un error.

## Tests

Fixtures reales capturadas del portal —HTML de los CGI, JSON de las APIs REST— guardadas en `tests/fixtures/`. Los tests de parsing corren contra las fixtures, sin red, con el `jest` que ya está configurado.

Cada scraper nuevo lleva tests de: parsing del caso con datos, parsing del caso vacío, y detección de respuesta corrupta o no autenticada.

`SiiHttpClient` se testea con un transporte inyectado, verificando decodificación ISO-8859-1, reautenticación ante sesión caída y mapeo de errores tipados.

Las tools de escritura llevan test explícito de que con `confirmar: false` no se emite nada.

## Fuera de alcance

- Migrar los scrapers existentes (mipyme, DTE, bienes raíces) a HTTP. Funcionan; migrarlos es un trabajo aparte.
- Envío de declaraciones (F22, F29, declaraciones juradas). Riesgo desproporcionado para el valor.
- Boletas de terceros (BTE), descarga de PDF, y las 14 categorías empresa-céntricas restantes del portal.
