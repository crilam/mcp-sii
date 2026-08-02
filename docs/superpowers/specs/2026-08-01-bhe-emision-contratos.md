# Contratos del flujo de emisión de BHE

Fecha: 2026-08-01
Estado: relevado contra el portal real, **sin emitir ningún documento**

Este documento es el resultado de la Tarea 7 (spike) del plan de la Fase 1. No entrega código: entrega los datos con los que se planifica `sii_bhe_emitir` y `sii_bhe_anular`.

## Qué se hizo y qué no

Se recorrieron por HTTP autenticado los pasos de **lectura** del flujo de emisión: la pantalla de selección de tipo de retención y el formulario de datos de la boleta. Se enumeraron sus campos y se compararon dos cargas sucesivas del formulario.

**No se ejecutó el paso que emite.** Emitir una boleta de honorarios es un acto tributario real e irreversible que además notifica al receptor. Tampoco se emitió "para probar" con intención de anular después: una BHE emitida y anulada deja rastro en el SII y notifica igual.

## La cadena de cinco pasos

Base: `https://loa.sii.cl/cgi_IMT/`

| # | CGI | Qué hace | Escribe |
|---|---|---|---|
| 1 | `TMBECN_ValidaTimbrajeContrib.cgi?modo=1` | Elegir tipo de retención | No |
| 2 | `TMBECN_PresentaDatosBoleta.cgi` | Formulario de datos de la boleta | No |
| 3 | `TMBECN_ConfirmaTimbrajeContrib.cgi` | **Previsualiza.** Valida y muestra la boleta sin emitirla | No |
| 4 | `TMBECN_BoletaHonorariosElectronica.cgi` | **Emite.** Asigna folio | **Sí** |
| 5 | `TMBECN_PresentaDatosEnvio.cgi` → `TMBECN_EnviarBoleta.cgi` | Envía la boleta al receptor por correo | Sí |

La separación entre el paso 3 y el paso 4 es lo que hace implementable el guardrail de dry-run del spec: `confirmar: false` recorre hasta el paso 3 y devuelve la previsualización; `confirmar: true` continúa al paso 4.

El paso 5 es independiente: emitir y notificar al receptor son operaciones distintas en el SII. La tool debe decidir explícitamente si notifica, y decirlo en su respuesta.

En el código del portal, los pasos 3 y 4 corresponden a dos acciones distintas del mismo formulario (`validar` y `confirmar` en `presionaBoton()` de `TMBECN_Emision.js`), no a dos estados de una misma petición.

## El campo `tiempo`

El paso 2 inyecta `xml_values['tiempo']` con un timestamp Unix. Dos cargas sucesivas del mismo formulario devolvieron valores distintos —`1785627637` y `1785627672`— y ambos coinciden con la hora del reloj al momento de cada petición.

Conclusión: **lo genera el servidor en cada carga del formulario.** No se determinó si el SII lo valida como protección anti-replay o si solo lo usa para registrar cuándo se armó la boleta.

Regla para el implementador: **propagarlo tal cual llega y nunca regenerarlo del lado del cliente.** Si resulta ser anti-replay, un valor inventado hace fallar la emisión; si no lo es, propagarlo no cuesta nada. La asimetría de riesgo es clara.

## Estado del wizard

**No hay sesión de wizard del lado del servidor.** El estado viaja en campos ocultos que cada paso reenvía al siguiente. Fuera de las cookies de autenticación, los pasos son independientes.

Consecuencia para el diseño: el cliente HTTP solo debe propagar los campos entre pasos, sin mantener estado propio ni depender de un orden implícito del servidor.

## Campos del formulario (paso 2)

Relevados de una carga real. **No se determinó cuáles son obligatorios**: eso solo se sabe al ejercitar el paso 3, que valida.

### Ocultos, arrastrados por el flujo

| Campo | Origen |
|---|---|
| `rut_arrastre`, `dv_arrastre` | RUT del emisor, inyectado por el servidor |
| `dia_actual`, `mes_actual`, `anio_actual` | Fecha del servidor |
| `sin_destinatario` | `"SI"` / `"NO"` |
| `OptTipoRetencion` | `RETRECEPTOR` o `RETCONTRIBUYENTE` |
| `hdn_muestra_glosa`, `hdn_glosa_actividad` | Glosa de la actividad económica |

### Datos del receptor

`txt_rut_destinatario`, `txt_dv_destinatario`, `txt_nombres_destinatario`, `txt_domicilio_destinatario`, `txt_comuna_destinatario`, `cbo_comuna`, `cod_region`

### Datos del emisor

`cbo_domicilio`, `txt_comuna`, `txt_telefono`, `txt_fax`

### Fecha de la boleta

`cbo_dia_boleta`, `cbo_mes_boleta`, `cbo_anio_boleta`

### Detalle de la prestación

`desc_prestacion_1` a `desc_prestacion_4` y `valor_prestacion_1` a `valor_prestacion_4`, más `cantidad_filas_ingreso`. El formulario admite **hasta cuatro líneas de detalle**, dato que el spec no contemplaba.

Hay además tres campos que parecen una serialización del detalle: `hidden_data_cantidad`, `hidden_data_descripciones`, `hidden_data_valores`. No se determinó si el servidor usa estos o los `desc_/valor_` individuales.

### Otros

`rdb_glosa` (selección de glosa), `cmdAceptar` (botón).

## Datos útiles que devuelve el paso 2

Sin costo adicional, el formulario trae:

- `num_ult_boleta` y `fecha_ult_boleta` — el último documento emitido. Sirve para que el dry-run muestre contra qué correlativo se va a emitir.
- `razon_social`, `rut_contribuyente`, `actividades_sda_categoria` — identificación del emisor.
- `es_sociedad_profesionales` — afecta el tratamiento de la retención.
- `PorcentajeRetencion` — la tasa vigente.

## Reglas de negocio observadas en el código del portal

De `TMBECN_Emision.js`, sin ejecutarlas:

- **No se puede emitir una boleta hacia uno mismo.** El portal compara `rut_arrastre` con `txt_rut_destinatario` y lo bloquea.
- Si el receptor es persona jurídica (RUT mayor a 50.000.000) y el emisor es persona natural, el portal **cambia el tipo de retención** a `RETRECEPTOR` tras confirmar con el usuario. Una tool que emita debe resolver esto explícitamente en vez de heredar un default silencioso.

## Qué falta para poder implementar

1. **Cuáles campos son obligatorios y en qué formato.** Solo se sabe ejercitando el paso 3, que es seguro porque previsualiza sin emitir. Requiere datos de un receptor real, así que conviene hacerlo con un receptor propio conocido y con acuerdo previo.
2. **La forma de la respuesta del paso 3**, que es lo que devolverá el dry-run.
3. **El valor de `estado` para una boleta anulada.** Hoy `sii_bhe_list_emitidas` infiere `anulada` mirando dos señales porque no hay ninguna boleta anulada capturada. Se resuelve al relevar la anulación.
4. **Si `tiempo` es anti-replay.**

Hasta tener 1 y 2, escribir `sii_bhe_emitir` sería inventar el contrato.
