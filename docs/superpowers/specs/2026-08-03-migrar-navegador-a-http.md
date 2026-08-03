# Migrar el camino de navegador a HTTP: spike

Fecha: 2026-08-03
Estado: **viable, con una pregunta abierta que decide el valor de la migración**

Spike previa a migrar `sii_dte_*` y `sii_mipyme_*` desde `agent-browser` a HTTP directo.

## Por qué migrar

El camino de navegador es el obstáculo estructural del proyecto:

- Un Chrome compartido con **un solo almacén de cookies**: imposible aislar identidades.
- Estado global en rutas fijas (`$TMPDIR/sii_cookies.txt`, `sii_cert.pem`).
- Parsing de snapshots de accesibilidad, frágil ante cualquier rediseño.
- 70 llamadas al navegador en `mipyme.ts`, contra 3 en `bienesRaices.ts`.

Mientras esas tools dependan del navegador, no hay aislamiento por identidad posible — o sea, no hay servicio multi-entidad.

## El hallazgo que reduce el trabajo

**Las consultas DTE ya viven en una aplicación SDI.** `sii_dte_*` apunta a `https://www4.sii.cl/consemitidosinternetui/`, que es una SPA con el mismo sobre que ya usa `SiiHttpClient.postSdi()`.

```
base:      https://www4.sii.cl/consemitidosinternetui/services/data/facadeService
namespace: cl.sii.sdi.lob.diii.consemitidos.data.api.interfaces.FacadeService
```

17 métodos disponibles. Los relevantes para consulta:

| Método | Para qué |
|---|---|
| `getDatosInicio` | Catálogo de tipos de documento |
| `getDatosAsync` / `getDatosRecibidosAsync` | Listados del período |
| `getDetalle` / `getDetalleRecibidos` | Detalle de un documento |
| `getDetalleDTE` / `getDetalleDTERecibidos` | Detalle del DTE |
| `getEmpContribuyente` | Empresas del contribuyente |

`eliminarPublicacionDte` es de **escritura**: queda fuera de cualquier alcance de solo lectura.

Consecuencia: migrar `sii_dte_*` no es reescribir con otra técnica, es **mapear con el transporte que ya existe**. El trabajo es mucho menor de lo estimado.

## Contratos verificados

### `getDatosInicio`

`data: {rut, dv}`. Devuelve el catálogo de tipos de documento como `[{codigoDoc, descDoc}]`. Verificado.

### `getDatosAsync`

```json
{ "periodo": "<AAAAMM>", "rutContribuyente": "<RUT sin DV>", "dvContribuyente": "<DV>" }
```

Devuelve `{resumenDte, datosAsync}` con `respEstado.codRespuesta: 0`. Verificado que responde correctamente.

**Los nombres de campo son `rutContribuyente` / `dvContribuyente`, no `rut` / `dv`.** Enviar `rut` produce un 400 que nombra la clase Java (`ConsemitidosUiData$DteResumenEntityId`) y el campo rechazado — el mismo mecanismo de descubrimiento que en propuesta F29.

## La pregunta abierta, y por qué decide el valor de la migración

`getDatosAsync` respondió `codRespuesta: 0` pero con `datosAsync: []` y `resumenDte: null` para una empresa que **sí tiene documentos** en ese período — el Registro de Compras y Ventas informa 415 documentos de venta para el mismo RUT y período.

Dos explicaciones posibles, y no se distinguieron:

1. **`getDatosAsync` no es el listado**, sino el disparador o consultor de un trabajo asíncrono. El nombre lo sugiere, y en ese caso hay que encontrar el método que devuelve los datos.
2. **La aplicación valida la empresa contra la sesión**, no como parámetro. Hay un indicio fuerte: `getEmpContribuyente` se invoca en el bundle con `{rutContribuyente: sdiSession.rut, dvContribuyente: sdiSession.dv}` — o sea, el RUT **de la sesión**, igual que en la propuesta F29.

**Si es la explicación 2, la migración no compra el aislamiento buscado.** Movería el problema de la empresa seleccionada desde el navegador hacia la sesión SDI, sin resolverlo: seguiría habiendo estado compartido por proceso, sólo en otro lugar.

Eso hay que determinarlo **antes** de migrar, porque decide si el trabajo sirve para el objetivo o sólo cambia de tecnología.

## `codRespuesta` significa cosas distintas en cada aplicación

En esta app, `codRespuesta: 99` es **"Usuario no autorizado"** (`codError: cnsmtds.1.1.00`). En el Registro de Compras y Ventas, el mismo `99` es **período fuera del rango del registro**.

Es la confirmación empírica de que el default seguro implementado en `rcv.ts` era la decisión correcta: una tabla de códigos compartida entre aplicaciones habría interpretado mal uno de los dos casos. Cada aplicación necesita su propio mapeo, y lo desconocido debe fallar citando el código.

## Lo que no se relevó

- **La selección de empresa** (`mipeSelEmpresa.cgi`, un CGI del portal). Es lo que hoy hace `SessionManager.selectEmpresa()` con el navegador.
- **El portal mipyme** (`mipyme.sii.cl`): listado y emisión de DTE. Es el resto de `mipyme.ts`.
- **`vica`** (bienes raíces): usa cola virtual Queue-it, que un cliente HTTP sin JavaScript podría no atravesar. Es el candidato más probable a quedarse en navegador.

## Próximo paso

Resolver la pregunta abierta antes de escribir código: determinar si `consemitidosinternetui` trata la empresa como parámetro o como estado de sesión.

La prueba es directa: consultar con `rutContribuyente` de una empresa y comparar contra el total que informa el RCV para el mismo período. Si coinciden, es parámetro y la migración procede. Si vuelve vacío, es sesión y hay que decidir si la migración sigue teniendo sentido.

Un error a no repetir de esta spike: se probó `getEmpContribuyente` con un RUT ficticio en lugar del RUT real de la sesión, y el "Usuario no autorizado" resultante no prueba nada sobre el modelo de autorización. Al probar autorización, los datos tienen que ser reales.
