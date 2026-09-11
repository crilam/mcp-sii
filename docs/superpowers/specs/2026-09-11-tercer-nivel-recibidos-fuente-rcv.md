# Tercer nivel de `recibidos`: ¿el RCV como fuente del eje de contraparte?

Fecha: 2026-09-11

**Esto es un relevamiento y una línea a evaluar, no un plan de implementación.**
No hay código nuevo en este documento ni se prendió nada: es lo que se midió en
vivo, lo que se descartó, y las preguntas que quedan abiertas antes de decidir
si vale la pena construir algo. Continúa la ficha del tercer nivel documentada
en `docs/integracion-api.md` (§ respaldo XML) y el contrato de errores de
`docs/superpowers/specs/2026-08-03-mipyme-http-contratos.md`.

## El problema que sigue sin cerrarse

El tercer nivel de troceo del respaldo XML entra cuando un día excede el tope
de 20 documentos del SII (`TOPE_DOCUMENTOS_SII`) incluso con `tipo_dte` puesto.
Usa dos ejes según el origen: **folio** para `emitidos`, **contraparte** para
`recibidos`. El eje de folio ya se verificó end-to-end contra el SII real (ver
la ficha fechada en `docs/integracion-api.md`); el de contraparte, no. Antes de
poder trocear `recibidos` por contraparte hace falta saber **qué contrapartes
emitieron documentos ese día**, y hoy esa pregunta se responde con el CGI de
listado `mipeAdminDocsRcp.cgi` (función `listarRecibidosDelDia` en
`src/scrapers/mipymeHttp.ts`) — el mismo CGI legacy cuyo comportamiento bajo
carga es justamente lo que este documento pone en duda.

## Lo que se midió el 2026-09-11, en vivo contra el SII real

En cinco sesiones distintas a lo largo del día, `mipeAdminDocsRcp.cgi` devolvió
la página de error genérica del portal —título «Error al contribuyente», aviso
«Por el momento no se puede responder a sus requerimientos»— en vez del
listado esperado. Las cinco veces con el mismo código de error, y las cinco
veces en la **primera** llamada de la sesión.

Datos relevantes de esas corridas:

- **La descarga funcionó.** `lista_documentos.cgi` / `download.cgi` respondió
  con normalidad para la misma empresa en la misma sesión. Lo que falla es el
  *listado*, no el portal entero ni la sesión.
- **No es el error de secuencia.** `assertEmpresaSeleccionada` —el que detecta
  «no ha seleccionado una Empresa»— no se disparó en ninguna corrida, así que
  no es un problema de orden de llamadas de nuestro lado.
- **Se descartó la hipótesis de volumen.** Un comentario de `mipymeHttp.ts`
  (`assertNoPaginaDeErrorDelPortal`) documenta que la medición previa de esta
  misma página contra este mismo CGI fue con una empresa de alto volumen —el
  comentario no postula el volumen como causa, sólo registra con qué empresa
  se midió—. Eso hizo sospechar, en esta investigación, que el fallo pudiera
  depender de cuánto tráfico tuviera la empresa consultada. La sospecha se
  descartó: en una sola sesión, con dos llamadas seguidas, una empresa de bajo
  volumen y una de alto volumen fallaron **las dos** con el mismo código. El
  volumen no es la causa.
- Con el volumen descartado, la explicación que queda es el **estado del
  portal en esa ventana de tiempo**. Esa hipótesis quedó **pendiente de
  reintentar en otra ventana horaria** — no se verificó en esta ronda.

### Una trampa real al leer el código de error

El código medido es `02.35.209.58.260.22`. Comparte los **tres primeros
octetos** (`02.35.209`) con el error de «no ha seleccionado una Empresa»,
documentado como `02.35.209.-1.148.10` en el contrato de mipyme HTTP — el
resto del código difiere (`58.260.22` contra `-1.148.10`). Son dos errores de
significado completamente distinto (uno es de secuencia, el otro de
disponibilidad del portal) que comparten ese prefijo: clasificar por prefijo
de código confundiría los dos casos. El código base ya clasifica por la frase
del cuerpo (`assertNoPaginaDeErrorDelPortal` hace exactamente eso, y a
propósito no ata la detección al `CODIGO:` completo, que varía entre
corridas), y es el criterio que conviene seguir usando.

## La consecuencia práctica

El eje de contraparte del tercer nivel de `recibidos` **no se pudo verificar
en vivo** en esta ronda, y por eso `RESPALDO_XML_TERCER_NIVEL` sigue apagado
por defecto. El otro eje —`tipo_dte` + folio, el que usan `emitidos`— **sí**
está verificado (ver la ficha fechada en `docs/integracion-api.md`), pero el
flag no tiene granularidad: prende los dos ejes a la vez. No hay forma de
activar folio (verificado) y dejar contraparte (no verificado) apagado.

## La línea a evaluar: el RCV como fuente del eje de contraparte

El dato que le falta al tercer nivel de `recibidos` —qué contrapartes
emitieron documentos ese día— también lo tiene el **RCV** (Registro de Compras
y Ventas), que ya está integrado en este servicio por una API propia, no por
los CGI legacy del portal mipyme. `FilaDetalleRcv` (`src/scrapers/rcv.ts`)
trae `contraparteRut`, `folio` y `fechaEmision` por documento. En principio,
la agrupación por contraparte y por día que hoy pide el CGI de listado se
podría armar del lado del cliente a partir de esas filas, sin tocar el CGI que
falló en esta medición.

Esto **no** es una implementación propuesta: es la observación que motiva las
preguntas de la sección siguiente, que son las que de verdad importan acá.

## Preguntas abiertas

### 1. ¿Esta línea reemplaza el eje de contraparte, o el problema completo?

`POST /v1/rcv/detalle` **exige** `tipo_doc` como parámetro obligatorio (ver
`docs/integracion-api.md`, § 6.2): no existe un "detalle del período entero"
sin fijar un tipo de documento. Eso quiere decir que esta línea **reemplaza el
eje de contraparte, no elimina el eje de tipo**: para saber quién emitió
documentos un día dado, hay que seguir iterando por `tipo_dte`, uno por
llamada.

Lo que cambia es la granularidad de esa iteración. El CGI legacy pagina un
listado **por día** (y el tercer nivel entra justamente cuando ese listado
de un solo día ya excede el tope); `/v1/rcv/detalle` en cambio pide
`periodo` en formato `AAAAMM` — un **mes entero** por llamada, no un día.
Eso sugiere una cuenta de llamadas distinta a la que hace el CGI: en vez de
una llamada por página de listado *por día*, sería una llamada por
`tipo_dte` con movimiento en el mes, que después se filtra del lado del
cliente a la fecha exacta y se agrupa por `contraparteRut`. El propio
catálogo `/v1/rcv/tipos-documento` existe, según su propia documentación,
justamente porque no hay "detalle sin tipo": sin él hay que adivinar los
códigos o sacarlos de un resumen que sólo lista los tipos con movimiento en
el período (`/v1/rcv/resumen`, que ya trae `filas` por `tipoDocCodigo`, así
que el universo de tipos a iterar para un período dado ya se conoce sin
adivinar).

Dicho de otro modo: si la cuenta de llamadas del camino actual es
"1 + N páginas de listado, por día, para un solo `tipo_dte` ya fijado por el
segundo nivel de troceo", la cuenta del camino RCV sería "1 llamada a
`/v1/rcv/resumen` para saber qué tipos tuvieron movimiento en el mes, más 1
llamada a `/v1/rcv/detalle` por cada uno de esos tipos, cubriendo el mes
entero de una vez" — potencialmente más barata en llamadas, pero **esto es
una deducción de lectura de código, no una medición**. Falta confirmar en
vivo que `/v1/rcv/detalle` efectivamente devuelve el mes completo sin
paginar en un caso real, y con qué costo si el mes es grande: la propia
documentación de ese endpoint dice que `totalDocumentos` se verificó "hasta
393 documentos, sin garantía de paginación por encima de eso" — un límite
que no se ha probado y que, si existiera, cambiaría la cuenta de arriba.

### 2. ¿El RCV refleja el día en tiempo real, o tiene el retraso típico de lo informado al SII?

No se verificó en esta ronda. Si el RCV tiene retraso frente a lo que el
portal mipyme ya sabe, un respaldo del día en curso (o de los últimos días)
podría no ver contrapartes que el CGI legacy sí vería — y eso sería cambiar
una fuente que **falla** (visiblemente, con una página de error reconocible)
por una que **miente** (responde 200 con datos incompletos y ninguna señal de
que le falta algo), que es un cambio para peor, no para mejor.

El dato clave es que esto **no hace falta asumirlo a ciegas**: el resumen del
RCV ya expone un campo de frescura observable en tiempo de ejecución.
`ResumenRcv.actualizadoAl` (`src/scrapers/rcv.ts`, poblado desde
`dcvFecModificacion` de la respuesta del SII) es un string con fecha en
formato `AAAA-MM-DD` (ver el ejemplo `"actualizadoAl": "2026-08-01"` en
`docs/integracion-api.md`, § 6.2) — o `null` cuando el SII no lo informa.

Eso abre una opción de diseño concreta, sin implementarla todavía: usar el RCV
como fuente del eje de contraparte **sólo cuando `actualizadoAl` cubra el día
pedido**, y caer al camino actual (el CGI legacy) cuando no. Con esto el
retraso deja de ser un riesgo silencioso — algo que habría que descubrir mirando
discrepancias después de los hechos — y pasa a ser una condición chequeable
antes de confiar en el dato. Queda pendiente verificar, con mediciones reales
y no con lectura de código, cuánto retraso tiene `actualizadoAl` en la
práctica: si típicamente cubre el día de ayer, el día en curso, o algo más
lejano, y si ese retraso es estable o varía.

### 3. Si el RCV lista una contraparte que el respaldo no trae, o al revés, ¿qué significa?

Este servicio (mcp-sii) no decide esto: es una decisión del consumidor
(el ERP), que ya tiene un criterio para tratar diferencias legítimas entre el
RCV y el respaldo de XML, documentado en
`docs/superpowers/specs/2026-09-03-respaldo-xml-dte-design.md` del repositorio
del ERP. El criterio ahí es explícito: **el RCV es justamente la fuente que se
sabe que sub-reporta** (`documentos_informados` no se usa para derivar
completitud comparando contra el RCV; un documento del RCV sin XML aparece
como "faltante", y la comparación es por conjunto, no por cantidad — un lote
con la misma cantidad pero folios distintos se reporta como diferencia, no
como éxito). Esa asimetría parece aplicar también acá: una contraparte que el
respaldo trae y el RCV no lista no es necesariamente un error nuestro —podría
ser el mismo sub-reporte conocido del RCV—, mientras que una contraparte que
el RCV lista y el respaldo (usando RCV como fuente de troceo) no llegó a bajar
sí sería un problema real, porque significaría que el propio mecanismo de
troceo se perdió una contraparte que él mismo dijo que existía.

Esto es una hipótesis por analogía, no una verificación: falta confirmar que
el mismo razonamiento sobre sub-reporte del RCV que vale para la comparación
final (RCV contra respaldo ya bajado) vale igual para el uso del RCV como
**insumo** del troceo (RCV como fuente de qué contrapartes pedir), que es un
rol distinto — ahí un RCV incompleto no produce una discrepancia detectable
después, produce directamente un tramo que nunca se pide.

## Qué mediciones destrabarían cada pregunta

- **Pregunta 1 (costo real en llamadas):** correr `/v1/rcv/resumen` y
  `/v1/rcv/detalle` contra un mes real con varios `tipo_dte` y volumen alto de
  `recibidos`, confirmando que el detalle no pagina por debajo del volumen real
  del caso, y contando cuántas llamadas totales hacen falta para cubrir un mes
  completo comparado con lo que hoy consume el listado del CGI para un solo
  día lleno.
- **Pregunta 2 (frescura):** medir `actualizadoAl` contra el mismo período en
  varios momentos del día y de la semana, para varias empresas, y ver si cubre
  el día en curso, el día anterior, o algo más atrasado, y si ese retraso es
  estable.
- **Pregunta 3 (semántica de la diferencia):** con datos de la medición de la
  pregunta 1 en la mano, comparar el conjunto de contrapartes que el RCV
  informó para un día contra el conjunto que el listado del CGI legacy
  informó para el mismo día (cuando el CGI esté disponible), y ver en qué
  dirección aparecen diferencias reales, si aparecen.
- **La hipótesis de "estado del portal en esa ventana"**, que quedó pendiente
  desde la sección de medición: repetir la llamada a `mipeAdminDocsRcp.cgi`
  en otra ventana horaria del día, para confirmar o descartar que el fallo del
  2026-09-11 fuera puntual de esa franja y no un problema estructural del CGI.
