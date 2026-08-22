# Homologación apigateway v2 — Sub-proyecto 1: Empresa, solo lectura

## Contexto

Tributy y AgenticERP consumen el adaptador REST de mcp-sii
(`https://mcp-sii.redcomercio.cl`). RDTE consume hoy apigateway.cl y migra a
mcp-sii en ~2 semanas, cuando esté probado. La meta de la serie de
sub-proyectos es homologar la FUNCIONALIDAD del catálogo v2 de apigateway.cl
(no su formato: mcp-sii mantiene su contrato propio `{ok, ...datos}` y sus
rutas `/v1/<dominio>/<accion>` — decisión explícita del usuario, RDTE adapta
su cliente al migrar).

Este sub-proyecto cubre los servicios de EMPRESA de solo lectura. La
escritura (emitir, anular, clasificar transacciones, set_resumen) queda para
una spec posterior, igual que los servicios de persona (sub-proyecto 2), los
indicadores públicos (sub-proyecto 3) y todo lo que requiere API oficial con
certificado/CAF (CAF, RTC, BTE, DTE-contribuyentes — otra arquitectura).

## Fase 0 (prerrequisito): pass-through de certificado en el adaptador REST

**Contexto y decisión (verificado con spike contra el SII real, 2026-08-21):**
el clave pass-through para CONSULTAS no es viable — el login por clave del SII
pasa por queue-it + F5 WAF, no deja cookies de sesión recuperables en el
navegador, y curl no puede reproducir el handshake anti-bot. El login por
CERTIFICADO sí funciona (`loginWithCert` obtiene el cookie jar por curl con
TLS mutual auth). Decisión del usuario: los consumidores (Tributy/AgenticERP)
mandan el material del certificado POR REQUEST, como `apigateway.cl auth.cert`.

**Spike que validó el enfoque**: recibir el `.pfx` como base64, escribirlo a un
temporal, armar una sesión `AuthStrategy.Certificate` con ese path y hacer una
consulta real (renta) → devolvió datos reales (2 declaraciones). El
pass-through de certificado descansa en `loginWithCert`, que ya está probado
end-to-end.

**Consecuencia del modelo anterior**: el pass-through REST hoy solo arma
sesiones `AuthStrategy.Clave` (`credencialesRuntime.ts:15`), que —como probó
el spike— no producen jar utilizable. Las rutas REST de rcv/renta/bhe/dte/
mipyme por clave devuelven `ERROR`. Con este cambio pasan a autenticar por
certificado.

**Contrato de credencial (reemplaza `clave` en el body de toda ruta con
sesión):** cada ruta recibe, en vez de `clave`:
- `certificado_base64` (string): el `.pfx`/PKCS#12 del contribuyente en base64.
- `certificado_password` (string): la password del `.pfx`.
- `clave_certificado_sii?` (string, opcional): la clave del certificado
  centralizado cargado en el SII (`SII_CERT_CLAVE_SII`), solo necesaria para
  FIRMAR/EMITIR — no para las consultas de este sub-proyecto. Se documenta
  para el sub-proyecto de escritura; acá no se usa.

**Cambios de código:**

- `ProveedorCredencialesRuntime`: nuevo método
  `guardarCertificado(rut, certificadoBase64, certificadoPassword, claveCertSii?)`
  que escribe el `.pfx` a un temporal (`rutaTemporalSii('pfxruntime', rut)`) y
  arma el `SiiConfig` con `strategy: Certificate`, `certPath` = ese temporal,
  `certPassword`, `claveCertificadoSii`. `borrar(rut)` además hace
  `fs.unlinkSync` del `.pfx` temporal (material de clave: no dejarlo en disco
  tras el request). El método `guardar(rut, clave)` existente queda para el
  flujo MCP por clave (que sigue sirviendo solo para `validar-clave`, no para
  consultas).
- `ejecutorPassThroughDe`: una variante
  `ejecutorPassThroughCertDe(registro, credenciales, rut, certificadoBase64,
  certificadoPassword)` que en `preparar` llama `guardarCertificado` y en
  `finalizar` `borrar` (que ahora limpia el `.pfx`). El `ejecutorPassThroughDe`
  por clave se conserva para no romper nada, pero las rutas de consulta pasan
  a la variante cert.
- Rutas REST existentes (rcv/renta/bhe/dte/mipyme) + las nuevas de este
  sub-proyecto: el zod cambia `clave: z.string().min(1)` por
  `certificado_base64: z.string().min(1)` + `certificado_password:
  z.string().min(1)`, y usan `ejecutorPassThroughCertDe`.
- **NO se toca `assertPuedeEntregarCookieJar`**: con estrategia Certificate ya
  pasa (esa es su condición actual). Tampoco hace falta `exportarCookiesAlJar`
  ni el fix de carrera multi-RUT del MCP (ese era específico del login por
  clave en browser compartido; el certificado escribe el jar por curl, no por
  browser). El modelo MCP local sigue con certificado de proceso (`.env`),
  intacto.

**Seguridad**: el `.pfx` y su password son material de clave de terceros. El
temporal se borra en `finalizar` de cada request (try/finally, aunque la
consulta falle). Nunca se loguea. El body con `certificado_base64` NO entra en
la auditoría (que ya solo registra `rut`, no el cuerpo). Igual que hoy con la
clave, el TLS del ALB protege el material en tránsito.

**Verificación e2e obligatoria de la fase 0** (con el `.pfx` real del `.env`,
mandado como base64): cada ruta REST existente (rcv/resumen,
renta/estado-declaracion, bhe/resumen, dte/list-documentos-emitidos,
mipyme/list-empresas) responde datos reales con `certificado_base64` +
`certificado_password` (sin certificado en el entorno del proceso) antes de
dar la fase por cerrada.

**Riesgo**: subir el `.pfx` en cada request es más pesado que una clave (unos
KB en base64), pero es exactamente lo que hace apigateway y el volumen es
chico. El temporal por request agrega I/O de disco menor; aceptable.

## Alcance

Cuatro dominios, siempre con el patrón existente
`src/core/<dominio>.ts` + `src/core/schemas/<dominio>.ts` +
`src/tools/<dominio>.ts` (MCP) + `src/rest/rutas/<dominio>.ts` (REST).

Salvo indicación contraria, TODA ruta de este sub-proyecto recibe `rut`,
`certificado_base64`, `certificado_password` y `empresa_rut?` además de sus
parámetros propios (ver Fase 0: pass-through de certificado). El dominio 4,
contribuyentes públicos, es la excepción: no lleva credencial. En MCP, la
credencial sigue siendo el certificado del proceso (`.env`), no un parámetro
de la tool.

### 1. RCV asíncrono (equivale a `sii/rcv/{compras,ventas}/async/*`)

El SII procesa detalles grandes en background. Tres operaciones que cubren
compras y ventas con el parámetro `operacion`:

- `POST /v1/rcv/async/solicitar` — `periodo` (AAAAMM), `operacion`
  (COMPRA|VENTA), `tipo_doc` (código numérico), `estado_documentos?`
  (REGISTRO|PENDIENTE|NO_INCLUIR|RECLAMADO). `estado_documentos` aplica
  SOLO a COMPRA: mandarlo con `operacion=VENTA` es `400 BAD_REQUEST` (regla
  en el zod de la ruta, no silencio). Respuesta:
  `{ok, solicitudId: number, uuid: string, registros: number}`.
- `POST /v1/rcv/async/estado` — scope + `solicitud_id`. Respuesta:
  `{ok, estadoProcesamiento: string, creada: string, terminada: string|null}`.
  `estadoProcesamiento` se reporta tal cual lo entregue el SII (los valores
  exactos se documentan en el código tras el spike; no se inventa un enum
  propio).
- `POST /v1/rcv/async/detalle` — scope + `solicitud_id`. Respuesta: el
  mismo shape de documentos que `/v1/rcv/detalle` (contrato ya existente).

Nota de naming: `estado_documentos` (filtro de negocio del registro de
compras) y `estadoProcesamiento` (estado de la solicitud async) se llaman
distinto a propósito — en el YAML de apigateway ambos se llaman `estado` y
es una fuente de confusión conocida.

El id de solicitud lo emite el SII: NO hace falta estado propio en Neon. El
caller guarda `solicitudId` y consulta cuando quiera — stateless de nuestro
lado.

**Riesgo conocido**: los endpoints async del backend RCV del SII no están
verificados desde `SiiHttpClient`. Spike primero (con la empresa real
la empresa del .env); si el SII no los expone por la vía que usamos, el dominio se
cae de la spec y se anota como limitación.

### 2. F29 (equivale a `sii/f29/*`)

- `POST /v1/f29/list-declaraciones` — + `periodo` (AAAAMM). Respuesta:
  `{ok, declaraciones: [{folio: number, estadoCodigo: string,
  estadoDescripcion: string, fechaPresentacion: string,
  totalAPagar: number|null}]}`. Período sin declaraciones →
  `{ok, declaraciones: [], sinDatos: true}` (vacío legítimo, no error —
  misma convención que renta/rcv).
- `POST /v1/f29/detalle` — + `folio`. Respuesta:
  `{ok, folio, periodo, codigos: [{codigo: string, glosa: string|null,
  valor: number}]}`. Folio inexistente → `{ok:false, error:
  'NO_ENCONTRADO'}` (error de negocio unificado, ver Decisiones).
- `POST /v1/f29/estados` — sin parámetros propios. Respuesta:
  `{ok, estados: [{folio: number, periodo: string, estadoCodigo: string,
  estadoDescripcion: string}]}` (equivale a `obtener_estados`).
- `POST /v1/f29/certificado-solemne` y `POST /v1/f29/formulario-compacto` —
  + `folio`. Respuesta: `{ok, pdfBase64: string,
  contentType: "application/pdf"}`.

Scraper nuevo `src/scrapers/f29.ts`. **Cómo se consulta otra empresa**
(`empresa_rut`): el mecanismo del backend F29 no está verificado — los dos
patrones existentes difieren (RCV mete rutEmisor en el sobre SDI,
`rcv.ts:256`; mipyme selecciona empresa server-side,
`mipymeHttp.ts:380`). El spike inicial de F29 determina cuál aplica; si el
F29 solo cuelga del RUT autenticado, `empresa_rut` se elimina de estas
rutas y se documenta.

### 3. Mipyme lectura restante (equivale a `sii/mipyme/*` de consulta)

Sobre el `MipymeScraper` existente. Todas llevan la credencial estándar
(`rut`, `certificado_base64`, `certificado_password`) y `empresa_rut?`
(resolución de empresa: la existente de mipyme — server-side,
`conEmpresaExclusiva`):

- `POST /v1/mipyme/info-contribuyente` — + `contribuyente_rut`, `tipo_dte`.
  Respuesta: `{ok, razonSocial: string, direccion: string|null,
  comuna: string|null, giro: string|null, autorizadoParaTipo: boolean}`.
- `POST /v1/mipyme/list-borradores` — + los mismos filtros opcionales que
  `list-dte-emitidos` (tipo_dte, fecha_desde, fecha_hasta, receptor_rut,
  folio, pagina — el YAML de apigateway también filtra borradores).
  Respuesta: mismo shape de listado que `list-dte-emitidos`, más
  `codigo: string` por fila — round-trip tal cual: el MISMO valor, sin
  transformación, es lo que acepta `borrador-pdf` (string aunque el SII lo
  entregue numérico: un identificador opaco no se aritmetiza y el string
  no rompe si el SII le agrega letras).
- `POST /v1/mipyme/borrador-pdf` — + `codigo` (string, el de
  list-borradores). Respuesta: `{ok, pdfBase64,
  contentType: "application/pdf"}`.
- `POST /v1/mipyme/list-dte-recibidos` — análogo del `list-dte-emitidos`
  existente, lado receptor, con `emisor_rut?` como filtro en lugar de
  `receptor_rut`. Mismo shape de respuesta.
- `POST /v1/mipyme/dte-pdf` y `POST /v1/mipyme/dte-xml` — + `tipo_dte`,
  `folio`, `lado` (emitido|recibido), `emisor_rut` (requerido si
  `lado=recibido`, prohibido si `lado=emitido` — ambas violaciones son
  `400 BAD_REQUEST` vía zod `.refine`). PDF →
  `{ok, pdfBase64, contentType: "application/pdf"}`; XML →
  `{ok, xmlBase64, contentType: "application/xml"}` (base64 también: el
  XML del SII viene en ISO-8859-1 y pasarlo crudo por JSON lo corrompe).

`emitir borrador` y `eliminar borrador` son escritura: fuera de alcance.

### 4. Contribuyentes públicos (equivale a `sii/contribuyentes/*`)

Consultas SIN credencial de SII (páginas públicas del portal). Todas POST
con body JSON — el transporte actual parsea body incondicionalmente
(`restServer.ts:136`) y meter un GET obligaría a bifurcar ese pipeline;
uniformidad gana (los catálogos con POST son normales en RPC-style):

- `POST /v1/contribuyentes/situacion-tributaria` — `{rut}` (del tercero).
  Respuesta: `{ok, razonSocial: string|null, inicioActividades: boolean,
  fechaInicioActividades: string|null, autorizadoMonedaExtranjera: boolean,
  actividades: [{codigo: number, descripcion: string, categoria:
  number|null, afectaIva: boolean}], documentosTimbrados: [{documento:
  string, anioUltimoTimbraje: number}]}`. `categoria` es SIEMPRE el código
  numérico del catálogo (mismo tipo que en actividades-economicas); null
  cuando el portal no lo informa para esa actividad. RUT inexistente para
  el SII → `{ok:false, error:'RUT_INVALIDO'}`.
- `POST /v1/contribuyentes/verificar-rut` — `{rut, serie}` (número de serie
  de la cédula). Respuesta: `{ok, vigente: boolean}` — una cédula NO
  vigente es `{ok:true, vigente:false}` (resultado de negocio válido, no un
  error); `{ok:false}` queda para fallas reales de la consulta.
- `POST /v1/contribuyentes/actividades-economicas` — `{categoria?}`
  (número, filtro opcional — presente en el YAML de apigateway). Respuesta:
  `{ok, actividades: [{codigo: number, descripcion: string, categoria:
  number, afectaIva: boolean, disponibleInternet: boolean}]}`.

Estas rutas IGUAL pasan por auth de tenant + rate-limit + auditoría. Al no
haber credencial de SII, no usan `ejecutorPassThroughDe`. El scraper
`src/scrapers/contribuyentes.ts` usa el `Browser` con un `sessionId` fijo
propio (`contribuyentes-publico`) — el modelo de agent-browser es de
contextos nombrados persistentes, no efímeros; un contexto público
compartido y una `ColaPorClave` con esa clave fija serializan las consultas
sin abrir N Chromes (misma primitiva de cola que ya usa
`RegistroSesiones`).

Del lado MCP, las tres se exponen como tools normales (los parámetros van
en el input de la tool; que la REST sea POST-con-body las deja
simétricas).

## Decisiones de diseño

- **Binarios como base64 dentro del JSON** (`pdfBase64`/`xmlBase64` +
  `contentType`), nunca streaming binario: mantiene el contrato `{ok, ...}`
  uniforme y simplifica los clientes. **Requiere un camino binario nuevo en
  `SiiHttpClient`**: los métodos actuales devuelven siempre string
  decodificado (`decodificarRespuesta`, `http.ts:46-84`), lo que corrompe
  un PDF. Se agrega `getBuffer(url)` (y `postFormBuffer` si algún PDF exige
  POST) que corta el content-type sobre bytes (el corte por
  `MARCA_CONTENT_TYPE` ya trabaja sobre bytes, `http.ts:204`) y devuelve
  `Buffer` crudo sin pasar por TextDecoder. Los PDF del SII pesan decenas
  de KB; si algún certificado supera ~5 MB se revisa (no se espera).
- **Sin estado propio para async**: el `solicitudId` del SII viaja al
  caller y vuelve. Nada en Neon, nada en memoria.
- **Tests de contrato contra apigateway v1**: script e2e manual
  (`src/scripts/compararConApigateway.ts`, corre con `APIGATEWAY_TOKEN` del
  `.env`) que consulta el mismo dato en apigateway y en mcp-sii y reporta
  diferencias de CONTENIDO (no de forma). No corre en CI (token + SII
  real); es la herramienta de la verificación manual de cada dominio antes
  del PR. El token es legacy y se revoca al terminar la homologación.
- **Errores**: mismo esquema vigente — zod 400 `BAD_REQUEST`, credenciales
  `CREDENCIALES_INVALIDAS`, resto `ERROR` con log estructural. Errores de
  negocio nuevos, uniformes en todo el sub-proyecto:
  - `NO_ENCONTRADO`: el folio/código consultado no existe para el
    contribuyente — aplica a `f29/detalle`, `f29/certificado-solemne`,
    `f29/formulario-compacto`, `mipyme/borrador-pdf`, `mipyme/dte-pdf` y
    `mipyme/dte-xml`. Tributy/RDTE lo manejan programáticamente, así que
    es UN código, no uno por dominio.
  - `RUT_INVALIDO`: el RUT consultado no existe para el SII
    (contribuyentes).
  - Las rutas que devuelven PDF VALIDAN los magic bytes (`%PDF`) antes de
    encodear: si el SII devolvió HTML de error en vez del PDF, la
    respuesta es `NO_ENCONTRADO` (si el HTML lo dice) o `ERROR` — nunca un
    `pdfBase64` corrupto que el cliente descubre al abrirlo.
  - El dominio contribuyentes no tiene `CREDENCIALES_INVALIDAS` (no hay
    credencial).
- **MCP y REST a la vez**: cada operación nueva se expone por ambos, como
  todos los dominios existentes.

## Testing

- TDD por dominio: unit tests de scraper (fixtures HTML/JSON anonimizadas —
  el test de anonimización existente las vigila), de core, de tools y de
  rutas, como en los 6 dominios ya migrados.
- Verificación e2e manual por dominio con las credenciales reales del
  `.env` (persona y empresa de prueba del entorno) + comparación con
  apigateway v1 vía el script, antes de abrir cada PR.
- Suite completa + build + pr-review + merge + deploy por dominio (un PR
  por dominio, no uno gigante).

## Orden de implementación

0. **Fase 0** (pass-through de certificado): `guardarCertificado` +
   `ejecutorPassThroughCertDe` + cambiar el zod de credencial de las rutas
   (clave → certificado_base64/password) + verificar las 5 rutas REST
   existentes con el `.pfx` real. Sin esto, nada de lo que sigue funciona
   vía REST. (El spike ya confirmó que loginWithCert funciona con `.pfx`
   por request.)
1. Contribuyentes públicos (valida el patrón de scraper sin credencial).
2. Camino binario de `SiiHttpClient` (`getBuffer` + validación `%PDF`) —
   antes que F29 y mipyme, que lo consumen los dos.
3. F29 (spike de empresa_rut primero; luego patrón conocido).
4. Mipyme lectura restante (scraper existente, métodos nuevos).
5. RCV async (spike primero; si falla, se documenta y se cierra el
   sub-proyecto sin este dominio).

## Fuera de alcance (explícito)

- Escritura de cualquier tipo (emitir/eliminar borradores, set_* del RCV).
- Persona (BHE restante, MiSII, bienes raíces) — sub-proyecto 2.
- Indicadores públicos (UF, etc.) — sub-proyecto 3.
- CAF/RTC/BTE/DTE-contribuyentes — requieren arquitectura de API oficial.
- Compatibilidad de formato con apigateway (rutas/shapes propios de
  mcp-sii).
