# Ronda 1 — RCV completo

**Roadmap:** `2026-08-21-roadmap-homologacion-apigateway.md`
**Dominio:** `rcv` (12 endpoints en el catálogo, 2 en producción hoy)

## Por qué RCV abre las rondas

Es el dominio de mundo A más grande, y el criterio de orden es tamaño (decisión
del usuario). Además ya está parcialmente especificado: la parte asíncrona
viene del spec `2026-08-21-homologacion-empresa-lectura-design.md`, escrita con
detalle y **no ejecutada**. Esta ronda la retoma corrigiendo lo que envejeció.

## Fase 0 — Relevamiento: CERRADA (2026-08-26)

Se hizo, y cambió el alcance. El resumen está acá; el detalle, abajo.

**El async existe** (`getCtrlAsync`), así que el riesgo heredado se cierra: no
hay que caerlo de la spec. Pero el hallazgo grande es otro.

**El SII expone del RCV bastante más de lo que leemos.** El método
`getDetalleCompraExport` devuelve el detalle en CSV con **26 columnas**;
nuestro `/v1/rcv/detalle` (que usa `getDetalleCompra`, la variante JSON)
publica 15 campos. Faltan ~14 datos tributarios, y no son de adorno para quien
arma un F29: IVA no recuperable con su código, monto neto e IVA de activo fijo,
IVA de uso común, impuesto sin derecho a crédito, IVA no retenido, fecha de
recepción y de acuse, y otros impuestos con código, valor y tasa.

O sea que el valor de esta ronda no está sólo en agregar endpoints: está en
**completar un dato que ya devolvemos incompleto**.

### Cómo se relevó (sirve para las rondas siguientes)

Adivinar nombres de método no funcionó: cuatro candidatos, cuatro fallos. Lo
que funcionó fue bajar el bundle del portal y leer de ahí los nombres reales
—el mismo método que sirvió para descubrir el PDF de BHE—. El portal es una app
AngularJS y su `app.full.min.js` (863 KB) declara los métodos del facade.

Una trampa que costó una corrida: el HTML del portal emite los atributos **sin
comillas** (`<script src=https://...>`), así que una regex que exija comillas
no encuentra ningún script y el relevamiento sale vacío sin fallar.

### Los 21 métodos del facade de RCV

Lectura, ya implementados: `getResumen`, `getDetalleCompra`, `getDetalleVenta`.

Lectura, NO implementados:
`getResumenExport`, `getDetalleCompraExport`, `getDetalleVentaExport`,
`getCtrlAsync`, `getDatosInicio`, `getDcvEmpresasAutorizadas`, `getDetalleDTE`,
`getEventosDoc`, `getOtrosImpuestos`, `getDetalleIEC02`, `getStringValue`.

Observaciones (una familia entera sin tocar): `getDetallesObs`,
`getDetalleObsCompraExp`, `getDetalleObservacionRutDoc`,
`getDetalleObservacionTpoDoc`, `getResumenObsCruce`,
`getResumenObservacionesRutTpoDoc`.

**Escritura — NO va en esta ronda:** `ingresarAceptacionReclamoDocs` (aceptar o
reclamar documentos). Es un acto real frente a terceros y va a la ronda de
escritura (R11), con idempotencia y confirmación explícita.

### Verificado en vivo

Contra la empresa del `.env`, período 06/2025, con el control de `getResumen`
respondiendo primero para separar "el método no existe" de "la sesión no
sirve": `getDetalleCompraExport`, `getResumenExport` y `getCtrlAsync` devuelven
los tres `codRespuesta: 0`. `getCtrlAsync` da lista vacía, que es lo esperado
sin solicitudes en curso.

## Fase 0 — Relevamiento (planteo original, cumplido)

No se escribe código hasta cerrar esto. Son las dos incógnitas que pueden
cambiar el alcance entero:

1. **Qué son los 12 endpoints de `rcv` en apigateway.** El conteo del roadmap es
   de segunda mano y su documentación es una SPA que no se puede enumerar por
   fetch — hay que abrirla con navegador. Sin esta lista, "RCV completo" no
   tiene definición y la ronda no puede darse por terminada.

2. **Si el backend async del SII responde por la vía que usamos.** Riesgo
   heredado del spec anterior y sigue abierto: los endpoints asíncronos no
   están verificados desde `SiiHttpClient`. **Si no responden, el async se cae
   de la spec y se anota como limitación conocida** — no se fuerza.

El spike va contra la empresa del `.env`, en una sola sesión, y con el cierre
completo (`cerrarSesionSii`) en un `finally`.

## Alcance propuesto (a confirmar tras la Fase 0)

### 1. RCV asíncrono

El SII procesa los detalles grandes en background. Tres operaciones que cubren
compras y ventas con el parámetro `operacion`:

- `POST /v1/rcv/async/solicitar` — `periodo` (AAAAMM), `operacion`
  (COMPRA|VENTA), `tipo_doc` (código numérico), `estado_documentos?`
  (REGISTRO|PENDIENTE|NO_INCLUIR|RECLAMADO). `estado_documentos` aplica **sólo**
  a COMPRA: mandarlo con `operacion=VENTA` es `400 BAD_REQUEST` explícito, no
  silencio. Respuesta: `{ok, solicitudId, uuid, registros}`.
- `POST /v1/rcv/async/estado` — + `solicitud_id`. Respuesta:
  `{ok, estadoProcesamiento, creada, terminada|null}`. `estadoProcesamiento` se
  reporta **tal cual lo entrega el SII**; los valores exactos se documentan tras
  el spike y no se inventa un enum propio.
- `POST /v1/rcv/async/detalle` — + `solicitud_id`. Respuesta: el mismo shape de
  documentos que `/v1/rcv/detalle`, que ya es contrato.

El id de solicitud lo emite el SII, así que no hace falta estado propio en Neon:
el caller guarda `solicitudId` y consulta cuando quiera. Stateless de nuestro
lado.

Nota de naming, heredada y que conviene respetar: `estado_documentos` (filtro
del registro de compras) y `estadoProcesamiento` (estado de la solicitud) se
llaman distinto **a propósito** — en el YAML de apigateway ambos se llaman
`estado` y es una fuente de confusión conocida.

### 2. Lo que aparezca en el relevamiento

Los 12 endpoints menos los 2 que ya tenemos y los 3 async dejan ~7 por
identificar. Del roadmap se sabe que hay escritura (`set_tipo_transaccion`,
`set_resumen`), pero **eso NO entra en esta ronda**: son actos que modifican el
registro del contribuyente y van a la ronda de escritura (R11), que pide
idempotencia y confirmación explícita. Si el relevamiento muestra que el resto
de `rcv` es escritura, esta ronda se cierra con el async y se dice así.

## Correcciones sobre el spec heredado

Lo que cambió desde el 21-08 y hay que aplicar al retomarlo:

- **Credencial: `conCredencial` (clave o certificado), no `zodCredencialCert`.**
  El spec original nació cuando el pass-through por clave se creía inviable.
  Desde el PR #55 la clave funciona en todas las consultas, verificado contra el
  SII. Estas rutas nacen aceptando las dos.
- **`RUT_INVALIDO` no existe.** El spec lo listaba entre los errores. Un RUT mal
  formado es `BAD_REQUEST` con `detalle`; para un RUT con DV inválido, el
  `detalle` dice cuál correspondía (ver `contribuyente/situacion-tributaria`).
- **Hay dos códigos nuevos** que estas rutas heredan gratis y conviene conocer:
  `LIMITE_CONOCIDO` (permanente, no reintentar) y `SESIONES_SIMULTANEAS`
  (reintentar tras esperar).

## Riesgos

| Riesgo | Qué hacer |
|---|---|
| El backend async no responde por `SiiHttpClient` | Se cae de la spec, se anota como limitación. No se fuerza. |
| El relevamiento muestra que `rcv` es más chico de lo contado | Se ajusta el alcance y se dice en el PR. El conteo es orientativo. |
| Los detalles async son grandes | Ya hay techo de 4 MiB en el transporte y `LIMITE_CONOCIDO` para pasarlo. Verificar con un período real grande. |
| Solicitudes que nunca terminan | `estado` las reporta tal cual; no se inventa un timeout propio. |

## Criterio de terminado

1. Relevamiento cerrado y alcance confirmado por escrito.
2. Rutas REST + tools MCP a la par.
3. Tests con fixtures anonimizadas, y **verificado que los tests fallan si se
   rompe lo que dicen proteger**.
4. Verificación e2e contra el REST **desplegado**, no sólo la cadena local.
5. `docs/integracion-api.md` y README al día.
6. Aviso a la sesión de Tributy si cambia algo del contrato.
