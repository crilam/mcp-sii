# Migrar el camino de navegador a HTTP: spike

Fecha: 2026-08-03
Estado: **contrato resuelto y verificado.** Listo para implementar.

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

### El contrato completo, resuelto

El vacío no era de autorización sino de parámetros. Faltaban dos cosas:

```json
{ "periodo": "2026-07",
  "rutContribuyente": "<RUT sin DV>",
  "dvContribuyente": "<DV>",
  "operacion": 1 }
```

1. **El período va como `AAAA-MM`, con guión** — no `AAAAMM` concatenado. El bundle lo arma como `f + "-" + e`.
2. **`operacion` es obligatorio**: `1` emitidos, `2` recibidos. No estaba en las formas de payload que se encontraron primero.

Con eso, `getResumen` devuelve el resumen por tipo de documento. Verificado contra el portal.

### `seccion` es parte de la clave, no un adorno

Cada fila trae un campo `seccion`, y **el mismo `tipoDoc` puede aparecer dos veces con secciones distintas**. En el período probado, el tipo 61 aparece como `S1` con 20 documentos y como `S2` con 2.

| Sección | Qué agrupa |
|---|---|
| `S1` | Documentos afectos y exentos normales |
| `S2` | Facturas de compra (46) y sus notas de crédito |
| `S4` | Exportación (110) |
| `S5` | Guías de despacho (52) |

**La clave es `(tipoDoc, seccion)`.** Un parser que agrupe sólo por `tipoDoc` colapsa filas distintas y suma mal.

## Consultas DTE y el Registro de Compras y Ventas NO son intercambiables

Este es el hallazgo con más consecuencias, y no se buscaba.

Comparando el mismo RUT y período contra lo que devuelve `sii_rcv_resumen`:

**Emitidos coinciden exactamente** en los tipos que ambos registros comparten — 393 facturas, 20 notas de crédito, montos idénticos al peso.

**Pero Consultas DTE incluye lo que el RCV no:**
- **Guías de despacho** (tipo 52): 22 emitidas y 10 recibidas. No aparecen en el RCV, y es correcto — no tienen efecto en el IVA.
- **Facturas de compra** (tipo 46) las clasifica como **emitidas** (sección S2), mientras que el RCV las pone del lado de compras. Ambas tienen razón: la emite el comprador.

**Y los recibidos difieren en los números:** 85 facturas contra 83 del RCV, y 3 notas de crédito contra 5.

Consecuencia para el diseño: `sii_dte_*` y `sii_rcv_*` responden **preguntas distintas** y van a mostrar cifras que no cuadran. Eso no es un bug de ninguno de los dos. La descripción de las tools debería decirlo, porque un modelo que compare las dos salidas va a concluir que una está mal.

Hipótesis para la diferencia en recibidos, sin verificar: el RCV refleja lo que el contribuyente registró o aceptó, y Consultas DTE lo que el SII recibió. Confirmarlo requiere mirar documento por documento.

## `codRespuesta` significa cosas distintas en cada aplicación

En esta app, `codRespuesta: 99` es **"Usuario no autorizado"** (`codError: cnsmtds.1.1.00`). En el Registro de Compras y Ventas, el mismo `99` es **período fuera del rango del registro**.

Es la confirmación empírica de que el default seguro implementado en `rcv.ts` era la decisión correcta: una tabla de códigos compartida entre aplicaciones habría interpretado mal uno de los dos casos. Cada aplicación necesita su propio mapeo, y lo desconocido debe fallar citando el código.

## Lo que no se relevó

- **La selección de empresa** (`mipeSelEmpresa.cgi`, un CGI del portal). Es lo que hoy hace `SessionManager.selectEmpresa()` con el navegador.
- **El portal mipyme** (`mipyme.sii.cl`): listado y emisión de DTE. Es el resto de `mipyme.ts`.
- **`vica`** (bienes raíces): usa cola virtual Queue-it, que un cliente HTTP sin JavaScript podría no atravesar. Es el candidato más probable a quedarse en navegador.

## Próximo paso

El contrato de `sii_dte_*` está resuelto y verificado. Es implementación, por orden:

1. **`sii_dte_list_documentos_emitidos` y `_recibidos`** → `getResumen` con `operacion` 1 y 2. La clave de agrupación es `(tipoDoc, seccion)`.
2. **`sii_dte_get_documento_emitido` y `_recibido`** → `getDetalle` / `getDetalleRecibidos`. Contratos sin relevar; el mecanismo de descubrimiento por error 400 ya está probado en esta app.
3. **La selección de empresa** — `getEmpContribuyente` devuelve el listado por parámetro, así que en el camino HTTP la selección probablemente deja de existir.
4. **El portal mipyme** (listado y emisión). Sin relevar.
5. **`vica`** (bienes raíces) — con cola virtual Queue-it. El candidato a quedarse en navegador, y está bien: son 3 llamadas contra 70.

Al implementar, dos cosas que este relevamiento dejó claras y conviene no perder: las descripciones de las tools tienen que advertir que `sii_dte_*` y `sii_rcv_*` no son comparables, y el mapeo de `codRespuesta` tiene que ser propio de esta aplicación — su `99` no significa lo mismo que el del RCV.

Un error a no repetir de esta spike: se probó `getEmpContribuyente` con un RUT ficticio en lugar del real, y el "Usuario no autorizado" resultante llevó a sospechar un modelo de autorización que no existía. Al probar autorización, los datos tienen que ser reales — con datos falsos, un rechazo no significa nada.
