# Migrar el camino de navegador a HTTP: spike

Fecha: 2026-08-03
Estado: **viable y con el aislamiento confirmado.** Queda un detalle de contrato para resolver al implementar.

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

## La pregunta que decidía el valor: resuelta a favor

La duda era si la aplicación trata la empresa como **parámetro** o como **estado de sesión**. Si fuera lo segundo, migrar movería el estado compartido del navegador a la sesión SDI sin eliminarlo, y no compraría el aislamiento que motiva el trabajo.

**Es parámetro.** `getEmpContribuyente` recibe `{rutContribuyente, dvContribuyente}` y devuelve las empresas de **ese** usuario, con sus privilegios:

```json
[{ "usrEmpRut": 33333333, "usrEmpDv": "3", "usrUsuarioRut": 11111111,
   "usrUsuarioDv": "1", "usrPrivilegios": "SSSSSS", "usrEmpRutDv": "33333333-3" }]
```

17 empresas para la cuenta probada — **la misma cantidad que habilita el Registro de Compras y Ventas**, a diferencia de las 5 que lista el portal mipyme. Dos aplicaciones distintas con la misma lista de autorización, y una tercera con otra.

Consecuencia: **la migración procede** y sí elimina el estado compartido. El aislamiento por identidad queda alcanzable.

### El detalle que queda

`getResumen` y `getDatosAsync` responden `codRespuesta: 0` con lista vacía para una empresa que sí tiene documentos en el período, y también para el RUT propio. Como la autorización quedó descartada, la causa está en el contrato: falta un parámetro, el período va en otro formato, o son endpoints asíncronos que requieren un disparador previo.

Es un detalle de implementación, no un obstáculo de decisión. La pista está en el camino de navegador que hoy funciona: `applyFiltrosEmitidos` selecciona tres combos —empresa, **mes como nombre**, año— lo que sugiere que el período puede no viajar como `AAAAMM` concatenado.

## `codRespuesta` significa cosas distintas en cada aplicación

En esta app, `codRespuesta: 99` es **"Usuario no autorizado"** (`codError: cnsmtds.1.1.00`). En el Registro de Compras y Ventas, el mismo `99` es **período fuera del rango del registro**.

Es la confirmación empírica de que el default seguro implementado en `rcv.ts` era la decisión correcta: una tabla de códigos compartida entre aplicaciones habría interpretado mal uno de los dos casos. Cada aplicación necesita su propio mapeo, y lo desconocido debe fallar citando el código.

## Lo que no se relevó

- **La selección de empresa** (`mipeSelEmpresa.cgi`, un CGI del portal). Es lo que hoy hace `SessionManager.selectEmpresa()` con el navegador.
- **El portal mipyme** (`mipyme.sii.cl`): listado y emisión de DTE. Es el resto de `mipyme.ts`.
- **`vica`** (bienes raíces): usa cola virtual Queue-it, que un cliente HTTP sin JavaScript podría no atravesar. Es el candidato más probable a quedarse en navegador.

## Próximo paso

Resolver por qué `getResumen` y `getDatosAsync` devuelven vacío, que es lo único que separa a `sii_dte_*` de poder migrarse. La pista está en el camino de navegador que hoy funciona: selecciona el mes **como nombre**, no como número, así que el período puede no viajar como `AAAAMM`.

Después, por orden de dificultad creciente:

1. **`sii_dte_*`** — la app es SDI y parámetrica. Es mapeo, no reescritura.
2. **La selección de empresa** — `mipeSelEmpresa.cgi` es un CGI con formulario. Si `getEmpContribuyente` cubre el listado, puede que la selección deje de ser necesaria en el camino HTTP.
3. **El portal mipyme** — listado y emisión. Sin relevar.
4. **`vica`** (bienes raíces) — con cola virtual Queue-it. El candidato más probable a quedarse en navegador, y está bien que quede: son 3 llamadas contra 70.

Un error a no repetir de esta spike: se probó `getEmpContribuyente` con un RUT ficticio en lugar del RUT real de la sesión, y el "Usuario no autorizado" resultante llevó a sospechar un modelo de autorización que no existía. Al probar autorización, los datos tienen que ser reales — con datos falsos, un rechazo no significa nada.
