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

## Alcance

Cuatro dominios, siempre con el patrón existente
`src/core/<dominio>.ts` + `src/core/schemas/<dominio>.ts` +
`src/tools/<dominio>.ts` (MCP) + `src/rest/rutas/<dominio>.ts` (REST):

### 1. RCV asíncrono (equivale a `sii/rcv/{compras,ventas}/async/*`)

El SII procesa detalles grandes en background. Tres operaciones por lado
(compras y ventas):

- `POST /v1/rcv/async/solicitar` — body: `rut`, `clave`, `periodo`,
  `operacion` (COMPRA|VENTA), `tipo_doc`, `estado` (REGISTRO|PENDIENTE|
  NO_INCLUIR|RECLAMADO; sólo aplica a COMPRA), `empresa_rut?`. Devuelve
  `{ok, solicitudId, uuid, registros}`.
- `POST /v1/rcv/async/estado` — mismo scope + `solicitud_id`. Devuelve
  `{ok, estado, creada, terminada}`.
- `POST /v1/rcv/async/detalle` — mismo scope + `solicitud_id`. Devuelve el
  mismo shape de documentos que `/v1/rcv/detalle` (contrato ya existente).

El id de solicitud lo emite el SII, no nosotros: NO hace falta estado propio
en Neon. El caller guarda `solicitudId` y consulta cuando quiera — stateless
de nuestro lado, igual que el resto del adaptador.

**Riesgo conocido**: los endpoints async del backend RCV del SII no están
verificados desde nuestro `SiiHttpClient`. La primera tarea del plan debe ser
un spike de verificación con la empresa real (78122544-4) ANTES de escribir
el resto — si el SII no expone async por la vía del portal que usamos, este
dominio se cae de la spec y se anota como limitación.

### 2. F29 (equivale a `sii/f29/*`)

- `POST /v1/f29/list-declaraciones` — `rut`, `clave`, `periodo` (AAAAMM),
  `empresa_rut?`. Listado de declaraciones del período: folio, estado,
  fecha presentación, montos principales.
- `POST /v1/f29/detalle` — `rut`, `clave`, `folio`, `empresa_rut?`. Todos
  los códigos del formulario con su valor (mapa código→valor + glosa cuando
  el SII la entrega).
- `POST /v1/f29/estados` — `rut`, `clave`, `empresa_rut?`. Estados
  disponibles del F29 del contribuyente (equivale a `obtener_estados`).
- `POST /v1/f29/certificado-solemne` y `POST /v1/f29/formulario-compacto` —
  `rut`, `clave`, `folio`, `empresa_rut?`. Devuelven
  `{ok, pdfBase64, contentType: "application/pdf"}`.

Scraping del portal (misma sesión clave/cert que Renta/F22). El scraper
nuevo `src/scrapers/f29.ts` sigue el patrón de `renta.ts`.

### 3. Mipyme lectura restante (equivale a `sii/mipyme/*` de consulta)

Sobre el `MipymeScraper` existente:

- `POST /v1/mipyme/info-contribuyente` — `rut`, `clave`, `empresa_rut?`,
  `contribuyente_rut`, `tipo_dte`. Información pública del contribuyente
  para emitirle (razón social, dirección, giro, autorizado para el tipo).
- `POST /v1/mipyme/list-borradores` — listado de borradores del emisor.
- `POST /v1/mipyme/borrador-pdf` — `codigo` del borrador → `{ok, pdfBase64}`.
- `POST /v1/mipyme/list-dte-recibidos` — análogo del list-dte-emitidos
  existente, lado receptor, con los mismos filtros.
- `POST /v1/mipyme/dte-pdf` y `POST /v1/mipyme/dte-xml` — `tipo_dte`,
  `folio`, `lado` (emitido|recibido), `emisor_rut` (para recibidos).
  PDF → `{ok, pdfBase64}`; XML → `{ok, xmlBase64}` (base64 también: el XML
  del SII viene en ISO-8859-1 y pasarlo crudo por JSON lo corrompe).

`emitir borrador` y `eliminar borrador` son escritura: fuera de alcance.

### 4. Contribuyentes públicos (equivale a `sii/contribuyentes/*`)

Consultas SIN sesión (páginas públicas del SII):

- `POST /v1/contribuyentes/situacion-tributaria` — `rut` (del tercero).
  Inicio de actividades, autorizado moneda extranjera, actividades
  económicas registradas, documentos timbrados.
- `POST /v1/contribuyentes/verificar-rut` — `rut`, `serie` (de la cédula).
  Vigencia de la cédula según el SII.
- `GET /v1/contribuyentes/actividades-economicas` — catálogo estático de
  códigos de actividad económica. Único GET del adaptador: no lleva body ni
  credencial de SII (sí requiere API key de tenant, como todo).

Estas rutas IGUAL pasan por auth de tenant + rate-limit + auditoría — que la
página del SII sea pública no significa que nuestro adaptador lo sea. Al no
haber credencial, no usan `ejecutorPassThroughDe`: un scraper sin sesión
(`src/scrapers/contribuyentes.ts`, browser efímero por request, serializado
con una cola global propia para no abrir N Chromes a la vez).

## Decisiones de diseño

- **Binarios como base64 dentro del JSON** (`pdfBase64`/`xmlBase64` +
  `contentType`), nunca streaming binario: mantiene el contrato `{ok, ...}`
  uniforme, simplifica los clientes (Tributy/AgenticERP ya parsean JSON) y
  la auditoría. Límite práctico: los PDF del SII pesan decenas de KB; si
  algún certificado supera ~5 MB se revisa (no se espera).
- **Sin estado propio para async**: el `solicitudId` del SII viaja al caller
  y vuelve. Nada en Neon, nada en memoria.
- **Tests de contrato contra apigateway v1**: script e2e manual
  (`src/scripts/compararConApigateway.ts`, corre con `APIGATEWAY_TOKEN` del
  `.env`) que consulta el mismo dato en apigateway y en mcp-sii y reporta
  diferencias de CONTENIDO (no de forma). No corre en CI (token + SII real);
  es la herramienta de la verificación manual de cada dominio antes del PR.
  El token es legacy y se revoca al terminar la homologación.
- **Errores**: mismo esquema vigente — zod 400 `BAD_REQUEST`, credenciales
  `CREDENCIALES_INVALIDAS`, resto `ERROR` con log estructural. Los dominios
  públicos (contribuyentes) no tienen `CREDENCIALES_INVALIDAS`: sólo
  `ERROR`, más `RUT_INVALIDO` si el SII responde que el RUT consultado no
  existe (error de negocio explícito, no un `ERROR` genérico).
- **MCP y REST a la vez**: cada operación nueva se expone por ambos, como
  todos los dominios existentes.

## Testing

- TDD por dominio: unit tests de scraper (fixtures HTML/JSON anonimizadas —
  el test de anonimización existente las vigila), de core, de tools y de
  rutas, como en los 6 dominios ya migrados.
- Verificación e2e manual por dominio con las credenciales reales del `.env`
  (persona 17.270.613-4, empresa 78122544-4) + comparación con apigateway
  v1 vía el script, antes de abrir cada PR.
- Suite completa + build + pr-review + merge + deploy por dominio (un PR por
  dominio, no uno gigante).

## Orden de implementación

1. Contribuyentes públicos (más simple, sin sesión — valida el patrón de
   scraper sin credencial).
2. F29 (patrón conocido, alto valor contable).
3. Mipyme lectura restante (scraper existente, sólo métodos nuevos).
4. RCV async (spike primero; si el spike falla, se documenta y se cierra el
   sub-proyecto sin este dominio).

## Fuera de alcance (explícito)

- Escritura de cualquier tipo (emitir/eliminar borradores, set_* del RCV).
- Persona (BHE restante, MiSII, bienes raíces) — sub-proyecto 2.
- Indicadores públicos (UF, etc.) — sub-proyecto 3.
- CAF/RTC/BTE/DTE-contribuyentes — requieren arquitectura de API oficial.
- Compatibilidad de formato con apigateway (rutas/shapes propios de mcp-sii).
