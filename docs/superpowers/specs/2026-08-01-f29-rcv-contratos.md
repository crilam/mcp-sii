# Contratos de impuestos mensuales: Registro de Compras y Ventas

Fecha: 2026-08-01
Estado: verificado en vivo contra `consdcvinternetui`

Spike previa a las tools de empresa. Continúa el hallazgo del [sobre SDI](2026-08-01-sdi-rest-contratos.md).

## El hallazgo principal: el sobre SDI generaliza

El sobre descubierto en la spike de renta funciona **sin cambios** en una aplicación de otro dominio, sin relación con F22. Lo único que cambia es el `namespace` y la base de la URL:

```
base:      https://www4.sii.cl/consdcvinternetui/services/data/facadeService/
namespace: cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService
```

Eso confirma que no era una particularidad de renta: es el contrato del portal moderno. `SiiHttpClient` puede exponer un único `postSdi(base, namespace, metodo, data)` y servir a todos estos dominios.

## Por qué el Registro de Compras y Ventas

De las 44 aplicaciones de "Impuestos mensuales", el RCV es la de mayor valor: es el registro que alimenta el F29. Antes de consultar el estado de una declaración, lo que un contribuyente necesita saber es qué documentos tiene registrados en el período.

Además evita un problema: por HTTP, la empresa es **un parámetro del método** (`rutEmisor`/`dvEmisor`), no un estado de sesión. No hay que seleccionar empresa en ninguna pantalla. Toda la fragilidad del multi-empresa que existe en el camino del navegador simplemente no aplica acá.

## Los 21 métodos disponibles

Extraídos del bundle. Los relevantes para consulta:

| Método | Para qué |
|---|---|
| `getDcvEmpresasAutorizadas` | Empresas que el RUT autenticado puede consultar en RCV |
| `getDatosInicio` | Catálogo de tipos de documento (código, nombre, electrónico o papel) |
| `getResumen` | Resumen del período: totales por tipo de documento |
| `getDetalleCompra` / `getDetalleVenta` | Detalle documento por documento |
| `getDetalleDTE` | Detalle de un DTE puntual |
| `getResumenObsCruce`, `getDetallesObs` | Observaciones y cruces |
| `getOtrosImpuestos` | Impuestos adicionales del período |
| `getEventosDoc` | Eventos de un documento |

`ingresarAceptacionReclamoDocs` es de **escritura**: acepta o reclama documentos recibidos. Queda fuera de cualquier alcance de solo lectura.

## Contratos verificados

### `getDcvEmpresasAutorizadas`

`data: {}`. Devuelve la lista de empresas habilitadas en RCV, con `usrEmpRut`, `usrEmpDv` y `usrEmpRutDv`.

**Dato importante: no coincide con la lista del portal mipyme.** En la cuenta probada, mipyme lista 5 empresas y RCV habilita 17. Son autorizaciones distintas, así que una tool no puede asumir que la lista de una sirve para la otra.

### `getResumen`

```json
{
  "rutEmisor": "<RUT sin DV>",
  "dvEmisor": "<DV>",
  "ptributario": "<AAAAMM>",
  "estadoContab": "REGISTRO",
  "operacion": "COMPRA"
}
```

`operacion` es `COMPRA` o `VENTA`. `ptributario` es el período tributario como `AAAAMM`. `estadoContab` sale de una constante del portal (`ESTADO_CONTAB_REGISTRO`); existen otros estados que no se relevaron.

Devuelve `data` con el resumen por tipo de documento, más `totDocRes` (total de documentos), `dataCabecera.dcvFecModificacion` (última actualización) y `verF29` (si el período tiene F29 asociado).

**Verificado:** una empresa devolvió `codRespuesta: 0` con `totDocRes: 2` en un período y `1` en el siguiente. Otra devolvió `3` en los mismos períodos.

## Códigos de respuesta

Esta aplicación **no** usa el `respCod` de renta: trae su propio `respEstado.codRespuesta`.

| Código | Significado | Cómo lo trata el portal |
|---|---|---|
| `0` | Éxito con datos | Puebla la vista |
| `3` | **Sin datos para el período** | No muestra nada, sin error |
| `2` | Error inesperado | Muestra un modal de error |
| `98` | Requiere redirección | Navega a otra URL |

La distinción entre `0` y `3` es la de siempre en este proyecto: **`3` es un vacío legítimo, no un fallo.** Un período sin movimientos y una empresa sin actividad responden igual. Confundirlo con un error haría que un mes tranquilo se reporte como falla.

Y al revés: tratar `2` como vacío ocultaría un error real. Los tres códigos tienen que mapearse explícitamente.

## Lo que falta antes de implementar

1. **La forma de `data` en `getResumen`** sólo se observó por su `totDocRes`; no se capturó ni anonimizó una respuesta completa con documentos. Hace falta antes de escribir el parser.
2. **`getDetalleCompra` / `getDetalleVenta`**: sus parámetros probablemente extienden los de `getResumen`, pero no se probaron.
3. **Los otros valores de `estadoContab`**: sólo se verificó `REGISTRO`.
4. **La Consulta Integral F29** (`sifmConsultaInternet`) es otra aplicación, con su propio namespace, todavía sin relevar. El RCV informa qué hay registrado; el F29 informa qué se declaró.

## Una advertencia sobre el alcance

Estas consultas son de solo lectura, pero el mismo servicio expone `ingresarAceptacionReclamoDocs`, que acepta o reclama documentos recibidos — un acto con consecuencias tributarias y sobre terceros. Cualquier tool que se construya acá debe declarar explícitamente que no lo toca, del mismo modo que se hizo con la emisión de boletas de honorarios.
