# Catálogo de endpoints de apigateway.cl (SII)

**Fuente:** cliente oficial Python `apigatewaycl/apigateway-api-client-python` (rama `master`),
repos crudos vía `raw.githubusercontent.com/apigatewaycl/apigateway-api-client-python/master/apigatewaycl/api_client/sii/*.py`.
Contrastado con el cliente PHP `apigatewaycl/apigateway-api-client-php` (mismo árbol de rutas, misma nomenclatura,
sin discrepancias encontradas en las rutas que ambos cubren).

Rutas mostradas tal como aparecen en el código (`/sii/...`); van montadas bajo el host base de la API
(`https://api.apigateway.cl` para v2 según el propio código: `if self.client.version == 'v1': ... else: ...`
indica que hay una v1 legacy y una v2 default — la mayoría de módulos no bifurcan por versión, solo
`actividades_economicas.listado()` lo hace explícitamente).

**No se pudo determinar la fuente primaria (OpenAPI/Swagger):** todos los intentos contra
`https://api.apigateway.cl/api/docs`, `/api/docs.json`, `/openapi.json`, `/api/openapi.json` fallaron por
DNS (host no resuelve desde este entorno — "could not resolve host", curl exit 6). `https://legacy.apigateway.cl/api/docs`
respondió 404 (página no encontrada, SPA sin ese endpoint). Por eso el catálogo se reconstruyó desde el
código fuente de los clientes oficiales, que enumeran cada endpoint con su HTTP method y parámetros.

**Dominios pedidos que NO aparecen en ningún cliente revisado (Python, PHP):** `bienes_raices`, `f29`
(formulario 29), `vehiculos`. No encontrados — no se incluyen filas inventadas para ellos.

**Dominios pedidos que SÍ aparecen:** bhe, misii, contribuyentes, dte, rcv, mipyme (portal_mipyme).
Adicionalmente aparece `indicadores` (UF) y `actividades_economicas`, no pedidos explícitamente pero
presentes en el catálogo real.

**bte** también aparece (pedido en la sección aparte). `eboleta` y `rtc` — no encontrados en ninguno
de los dos clientes revisados.

---

## bhe (Boletas de Honorarios Electrónicas)

| dominio | método | ruta | qué hace | body/query | notas |
|---|---|---|---|---|---|
| bhe | POST | `/sii/bhe/emitidas/documentos/{emisor}/{periodo}` | Lista BHE emitidas por un emisor en un período | body: `auth`; query opc: `pagina`, `pagina_sig_codigo` | requiere clave (auth) |
| bhe | POST | `/sii/bhe/emitidas/emitir` | Emite una nueva BHE | body: `auth`, `boleta` (dict con datos de la boleta) | escritura |
| bhe | POST | `/sii/bhe/emitidas/pdf/{codigo}` | Descarga el PDF de una BHE emitida | body: `auth` | PDF; `codigo` es el código único de la BHE (no el folio) |
| bhe | POST | `/sii/bhe/emitidas/email/{codigo}` | Envía por correo una BHE emitida | body: `auth`, `destinatario.email` | — |
| bhe | POST | `/sii/bhe/emitidas/anular/{emisor}/{folio}` | Anula una BHE emitida | body: `auth`; query: `causa` (1=sin pago, 2=sin prestación, 3=error digitación) | escritura |
| bhe | POST | `/sii/bhe/recibidas/documentos/{receptor}/{periodo}` | Lista BHE recibidas por un receptor en un período | body: `auth`; query opc: `pagina`, `pagina_sig_codigo` | — |
| bhe | POST | `/sii/bhe/recibidas/pdf/{codigo}` | Descarga el PDF de una BHE recibida | body: `auth` | PDF |
| bhe | POST | `/sii/bhe/recibidas/observar/{emisor}/{numero}` | Marca una observación sobre una BHE recibida | body: `auth`; query: `causa` (default 1) | escritura |

## misii

| dominio | método | ruta | qué hace | body/query | notas |
|---|---|---|---|---|---|
| misii | POST | `/sii/misii/contribuyente/datos` | Obtiene los datos del contribuyente autenticado en Mi SII | body: `auth`; query opc: `auth_cache=0` | requiere clave |

## contribuyentes

| dominio | método | ruta | qué hace | body/query | notas |
|---|---|---|---|---|---|
| contribuyentes | GET | `/sii/contribuyentes/situacion_tributaria/tercero/{rut}` | Obtiene la situación tributaria de un tercero | — | no requiere auth de contribuyente (dato público) |
| contribuyentes | GET | `/sii/contribuyentes/rut/verificar/{serie}` | Verifica un RUT (serie/dígito verificador) | — | — |
| contribuyentes | GET | `/sii/contribuyentes/actividades_economicas` | Lista actividades económicas (todas, o filtradas por categoría) | query opc: `categoria` (v2) / path `/…/{categoria}` (v1) | módulo `actividades_economicas`; helpers `listado_primera_categoria()`=cat 1, `listado_segunda_categoria()`=cat 2 |

## dte

| dominio | método | ruta | qué hace | body/query | notas |
|---|---|---|---|---|---|
| dte | GET | `/sii/dte/contribuyentes/autorizado/{rut}` | Verifica si un contribuyente está autorizado a emitir DTE | query: `certificacion` (0/1) | — |
| dte | POST | `/sii/dte/emitidos/verificar` | Verifica validez/autenticidad de un DTE emitido | body: `auth`, `dte.{emisor,receptor,dte,folio,fecha,total,firma}`; query: `certificacion` (0/1) | requiere clave; `firma` opcional |

## rcv (Registro de Compras y Ventas)

| dominio | método | ruta | qué hace | body/query | notas |
|---|---|---|---|---|---|
| rcv | POST | `/sii/rcv/compras/resumen/{receptor}/{periodo}/{estado}` | Resumen de compras registradas | body: `auth`; `estado` ∈ REGISTRO/PENDIENTE/NO_INCLUIR/RECLAMADO | — |
| rcv | POST | `/sii/rcv/compras/detalle/{receptor}/{periodo}/{dte}/{estado}` | Detalle de compras | body: `auth`; query: `tipo` (rcv/rcv_csv); `dte`=0 para todos | — |
| rcv | POST | `/sii/rcv/ventas/resumen/{emisor}/{periodo}` | Resumen de ventas registradas | body: `auth` | — |
| rcv | POST | `/sii/rcv/ventas/detalle/{emisor}/{periodo}/{dte}` | Detalle de ventas | body: `auth`; query: `tipo` (rcv/rcv_csv); `dte`=0 para todos | — |
| rcv | POST | `/sii/rcv/compras/async/solicitar/{receptor}/{periodo}/{dte}/{estado}` | Solicita generación asíncrona del detalle de compras | body: `auth` | async, paso 1 de 3 |
| rcv | POST | `/sii/rcv/compras/async/estado/{receptor}/{periodo}/{id_solicitud}/{dte}/{estado}` | Consulta el estado de una solicitud async de compras | body: `auth` | async, paso 2 de 3 |
| rcv | POST | `/sii/rcv/compras/async/detalle/{receptor}/{periodo}/{id_solicitud}/{dte}/{estado}` | Obtiene el detalle ya generado (async) de compras | body: `auth` | async, paso 3 de 3 |
| rcv | POST | `/sii/rcv/ventas/async/solicitar/{emisor}/{periodo}/{dte}` | Solicita generación asíncrona del detalle de ventas | body: `auth` | async, paso 1 de 3 |
| rcv | POST | `/sii/rcv/ventas/async/estado/{emisor}/{periodo}/{id_solicitud}/{dte}` | Consulta el estado de una solicitud async de ventas | body: `auth` | async, paso 2 de 3 |
| rcv | POST | `/sii/rcv/ventas/async/detalle/{emisor}/{periodo}/{id_solicitud}/{dte}` | Obtiene el detalle ya generado (async) de ventas | body: `auth` | async, paso 3 de 3 |

## mipyme (Portal MIPYME)

| dominio | método | ruta | qué hace | body/query | notas |
|---|---|---|---|---|---|
| mipyme | POST | `/sii/mipyme/contribuyentes/info/{contribuyente}/{emisor}/{dte}` | Info de un contribuyente en el contexto de un DTE tipo | body: `auth`; `dte` default 33 | — |
| mipyme | POST | `/sii/mipyme/emitidos/documentos/{emisor}` | Lista DTE emitidos por el emisor (Portal Mipyme) | body: `auth`, `filtros` (dict) | — |
| mipyme | POST | `/sii/mipyme/emitidos/pdf/{emisor}/{dte}[/{folio}]` | Descarga PDF de un DTE emitido | body: `auth` | PDF; `folio` opcional según variante de ruta |
| mipyme | POST | `/sii/mipyme/emitidos/xml/{emisor}/{dte}/{folio}` | Descarga XML de un DTE emitido | body: `auth` | XML |
| mipyme | POST | `/sii/mipyme/recibidos/documentos/{receptor}` | Lista DTE recibidos por el receptor (Portal Mipyme) | body: `auth`, `filtros` (dict) | — |
| mipyme | POST | `/sii/mipyme/recibidos/pdf/{receptor}/{emisor}/{dte}[/{folio}]` | Descarga PDF de un DTE recibido | body: `auth` | PDF; `folio` opcional |
| mipyme | POST | `/sii/mipyme/recibidos/xml/{receptor}/{emisor}/{dte}/{folio}` | Descarga XML de un DTE recibido | body: `auth` | XML |

## indicadores (no pedido explícitamente, pero presente)

| dominio | método | ruta | qué hace | body/query | notas |
|---|---|---|---|---|---|
| indicadores | GET | `/sii/indicadores/uf/anual/{anio}` | Valores de UF de todo un año | — | — |
| indicadores | GET | `/sii/indicadores/uf/anual/{anio}/{mes}` | Valores de UF de un mes | — | mismo prefijo `uf/anual/`, con más segmentos de path |
| indicadores | GET | `/sii/indicadores/uf/anual/{anio}/{mes}/{dia}` | Valor de UF de un día | — | ídem |

## Dominios pedidos SIN endpoints encontrados

- **bienes_raices**: no encontrada — no hay módulo ni ruta `/sii/bienes_raices/...` ni equivalente en los clientes Python/PHP revisados.
- **f29** (Formulario 29): no encontrada.
- **vehiculos**: no encontrada.

---

## Sección aparte: bte, eboleta, rtc

| dominio | método | ruta | qué hace | body/query | notas |
|---|---|---|---|---|---|
| bte | POST | `/sii/bte/emitidas/documentos/{emisor}/{periodo}` | Lista BTE emitidas | body: `auth`; query opc: `pagina` | — |
| bte | POST | `/sii/bte/emitidas/html/{codigo}` | Representación HTML de una BTE emitida | body: `auth` | HTML, no PDF |
| bte | POST | `/sii/bte/emitidas/emitir` | Emite una nueva BTE | body: `auth`, `boleta` | escritura |
| bte | POST | `/sii/bte/emitidas/anular/{emisor}/{numero}` | Anula una BTE emitida | body: `auth`; query: `causa` (default 3), `periodo` opc | escritura |
| bte | POST | `/sii/bte/emitidas/receptor_tasa/{emisor}/{receptor}` | Tasa de retención aplicada a un receptor | body: `auth`; query opc: `periodo` | — |
| eboleta | — | — | no encontrada — no hay módulo `eboleta` en los clientes Python/PHP revisados | — | — |
| rtc | — | — | no encontrada — no hay módulo `rtc` en los clientes Python/PHP revisados | — | — |

---

### Notas generales
- Casi todos los endpoints que requieren datos de un contribuyente autenticado envían `auth` en el body,
  generado por `self._get_auth_pass()` (RUT+clave del contribuyente) — no se ve soporte de certificado digital
  en ninguna de las rutas de este cliente.
- Las rutas de descarga de PDF/XML/HTML son POST (no GET), pese a ser "lecturas" — consistente con que
  llevan `auth` en el body.
- El flujo RCV async (`solicitar` → `estado` → `detalle`) es el único patrón asíncrono explícito encontrado en el catálogo.
- No se confirmó contra el spec OpenAPI real (no accesible desde este entorno) — todo lo anterior es
  inferencia directa del código fuente de los clientes oficiales, que en general reflejan 1:1 las rutas HTTP.
