# Ronda 11 — Escritura de portal (diseño)

**Estado:** diseño para revisión. NADA implementado. Ninguna escritura real fue
ejecutada durante el relevamiento.

**Objetivo:** exponer, con salvaguardas fuertes, las operaciones que MODIFICAN
estado en el SII: emitir/anular/observar/reenviar boletas de honorarios (BHE),
aceptar/reclamar documentos del RCV, y guardar borradores de mipyme.

**Principio rector:** una consulta equivocada se corrige; una escritura
equivocada es un acto tributario real e irreversible (un documento emitido, una
boleta anulada, un reclamo cursado). Por eso R11 no hereda el contrato de las
rondas de lectura: cada operación pasa por un guardrail explícito.

---

## 1. Qué se relevó (2026-08-31) y qué falta

Tres relevamientos de sólo lectura (bundles JS y código del repo), sin disparar
ninguna escritura.

### 1.1 BHE — portal CGI clásico (`loa.sii.cl/cgi_IMT/`)

Mismo mundo del que ya LEE `src/scrapers/bhe.ts` (sesión por cookie/certificado,
`SiiHttpClient` + `conSesionFresca`). **No es** el mundo `eboleta.sii.cl` (AWS
SigV4, DTE 39/41), que es otro sistema y no emite honorarios.

| Operación | Endpoint(s) | Estado del relevamiento |
|---|---|---|
| **Emitir** | Cadena de 5 pasos `TMBECN_*`: ValidaTimbrajeContrib → PresentaDatosBoleta → ConfirmaTimbrajeContrib → **BoletaHonorariosElectronica (emite)** → PresentaDatosEnvio/EnviarBoleta | CONFIRMADO hasta el paso 3 (previsualización, seguro). Params del paso 2 relevados. El paso 4 (emisión) y el 3 de respuesta faltan ejercitar. |
| **Anular** | `TMBANU_PrevalidaAnulacion.cgi` (+ confirmación por receptor: `TMBANU_ListarBheConfirmarReceptor.cgi`). Catálogo apigateway: por **folio** + `causa` (1 sin pago, 2 sin prestación, 3 error digitación) | INFERIDO. Falta relevar el form CGI real (GET del form, sin POST). |
| **Observar** | `TMBANU_ListarBheRechazarReceptor.cgi`. Catálogo: por `{emisor}`+`{numero}` + `causa`. Operación del RECEPTOR sobre boletas recibidas | INFERIDO. Falta relevar el form. |
| **Email** | Paso 5 de emisión: `TMBECN_PresentaDatosEnvio.cgi` → `TMBECN_EnviarBoleta.cgi`. Catálogo: por **`codigo`** (código de barras, el mismo del PDF) + destinatario | CONFIRMADO como paso de la cadena; forma standalone INFERIDA. |

Notas duras:
- La emisión NO tiene sesión de wizard en el servidor: el estado viaja en campos
  ocultos reenviados entre pasos. Hay un campo `tiempo` (timestamp Unix que el
  server inyecta en el paso 2) que se propaga tal cual — posible anti-replay.
- Regla del portal: no se puede emitir a uno mismo; si el receptor es persona
  jurídica y el emisor natural, se fuerza `OptTipoRetencion=RETRECEPTOR`.
- Identificadores distintos por operación: **folio** para anular, **código de
  barras** para email/PDF. No confundirlos.

### 1.2 RCV — facade `consdcvinternetui` (`FacadeService`)

- **Única escritura del facade JSON:** `ingresarAceptacionReclamoDocs`. Payload
  CONFIRMADO: `{ dteAcuRe: [{ detRutDoc, detDvDoc, detTipoDoc, detNroDoc,
  dedCodEvento }], rutAutenticado, dvAutenticado }`. Sobre SDI normal, **sin
  reCAPTCHA**. Respuesta: `respEstado.codRespuesta` (0 OK, 100 alerta, 2 error).
  Los `dedCodEvento` válidos NO se hardcodean: salen del catálogo
  `getEventosDoc({})` → `{dedCodEvento, dedDescEvento}`.
- **`set_tipo_transaccion` (clasificar Del Giro / Activo Fijo): FUERA DE
  ALCANCE.** No es una llamada al facade: es un redirect de página completa
  (`location.href` a `modtipocmpurl`, una app legacy distinta), con un
  `confirm()` nativo si el emisor tiene "comportamiento irregular". Automatizarlo
  es otro proyecto (relevar esa app aparte).
- **`set_resumen`: no existe** en el bundle. El roadmap lo listaba de más.

### 1.3 Mipyme — borradores

- El `borradorService` de la SPA `mipymeinternetui` **sólo LEE** (`version`,
  `listaBorrador`, `getProperty`, `rutEmpresa`). No hay crear/editar/eliminar en
  ese bundle.
- La escritura de un borrador vive en el flujo CGI de emisión (`mipeGenFacEx.cgi`
  → `mipeDisplayPreView.cgi`): guardar-como-borrador es un botón de ese form, no
  la SPA. FALTA relevar ese form (GET, sin ejecutar el guardado).
- `sii_mipyme_emitir_dte` YA escribe (emisión real, con flag `confirmar` y
  certificado): es el PATRÓN de guardrail a reutilizar, no algo a rehacer.

---

## 2. Diseño transversal: el guardrail

Todas las operaciones de escritura comparten un contrato, distinto del de
lectura.

### 2.1 `confirmar: boolean` (default `false`) — dry-run obligatorio

- `confirmar: false` (default): la operación recorre TODO menos el paso que
  muta, y devuelve `{ simulado: true, ... }` con lo que HARÍA (la
  previsualización del SII: folio propuesto, montos, receptor, causa). Es el
  paso 3 de BHE, la previsualización de mipyme, o un "validar sin cursar" del
  acuse RCV.
- `confirmar: true`: ejecuta la mutación. Es lo mismo que ya hace
  `emitirDte(params, confirmar)`.

Esto NO es opcional ni configurable por operación: es la barrera. Un consumidor
que quiere emitir hace dos llamadas — una para ver qué saldría, otra para
cursarlo — y la segunda lleva `confirmar: true` explícito.

### 2.2 Idempotencia y "consultar antes"

- Donde el SII expone un identificador estable (folio, código), la operación
  consulta el estado ANTES de mutar y se niega a repetir un acto ya hecho: anular
  una boleta ya anulada → error tipado, no una segunda anulación.
- La emisión no es idempotente por naturaleza (cada emisión asigna un folio
  nuevo). Ahí la salvaguarda es el dry-run + `confirmar:true` + un campo
  opcional `clave_idempotencia` que el consumidor arma (p.ej. hash de
  receptor+fecha+monto) y que el servicio rechaza si repite dentro de una ventana
  corta en memoria. NO se persiste en Neon (el servicio sigue stateless); es una
  red de última hora contra el doble-click, no una garantía transaccional.

### 2.3 Confirmación explícita en cada capa

- **REST:** sin `confirmar:true` en el body, la ruta devuelve el dry-run. Nunca
  emite por defecto.
- **MCP:** las tools de escritura llevan en la descripción, en mayúsculas, que el
  acto es irreversible, y exponen `confirmar` como parámetro. El modelo tiene que
  pasarlo. Además, las operaciones de mayor impacto (emitir, anular) pueden
  quedar FUERA de MCP y sólo en REST, para que un modelo no las dispare por su
  cuenta — decisión por operación (ver §4).

### 2.4 Errores tipados nuevos

- `EscrituraNoConfirmada` → REST `CONFIRMACION_REQUERIDA` (no es un error: es el
  dry-run devuelto con `simulado:true`). En rigor no lanza; el default devuelve
  la simulación.
- `ActoYaRealizado` → REST `YA_REALIZADO` (anular lo ya anulado, etc.).
- `EscrituraRechazadaPorSii` → REST `RECHAZO_SII`, con el mensaje del SII crudo
  (una emisión que el SII rechaza por regla de negocio: RUT inválido, sin
  timbraje, etc.).

### 2.5 Seguridad y verificación

- Ninguna escritura se verifica "a lo bruto" contra el SII: cada operación se
  prueba SÓLO con OK puntual del usuario y un caso de prueba concreto (una boleta
  a un RUT propio de prueba, un borrador descartable). El dry-run se puede
  ejercitar libremente; la mutación real no.
- Anonimización: los folios, códigos y RUT reales que aparezcan al verificar
  NUNCA se versionan (fixtures con dígitos repetidos, igual que el resto del
  repo).
- El barrido suave sigue vigente: una escritura es UNA llamada, sin reintentos
  automáticos que puedan duplicar el acto.

---

## 3. Contratos por operación (propuesta)

Todas bajo `POST /v1/...`, con `conCredencial` (clave o, donde el SII lo exija,
certificado). El cuerpo lleva siempre `confirmar` (default false).

### 3.1 RCV — aceptar/reclamar documentos (menor riesgo, relevado)

`POST /v1/rcv/acuse`
```
{ rut, documentos: [{ rut_emisor, tipo_doc, folio }], evento, confirmar? }
```
- `evento`: código del catálogo `getEventosDoc` (se expone también
  `GET/POST /v1/rcv/eventos-acuse` para listarlos, lectura).
- `confirmar:false` → valida y devuelve qué documentos se acusarían y con qué
  evento. `true` → llama `ingresarAceptacionReclamoDocs`.
- Reversibilidad: un acuse puede corregirse con otro evento; es el de menor
  impacto. Buen primer candidato.
- **Implementado (PR #79):** el contrato usa `rut_emisor` (no `rut_doc`). Errores
  tipados vivos: `LimitacionConocida` (código 100 del SII, evento fuera de
  catálogo, doble-click), `EscrituraRechazadaPorSii` → `RECHAZO_SII` (código de
  rechazo de negocio). Idempotencia con reserva SÍNCRONA (anti-race del
  doble-click concurrente). Catálogo de eventos cacheado 5 min por proceso.

### 3.2 Mipyme — guardar borrador (menor riesgo, falta relevar el form)

`POST /v1/mipyme/borrador`
```
{ rut, empresa_rut, dte: { tipo, receptor, detalle, ... }, confirmar? }
```
- Reversible: un borrador no es un DTE tributario. Se puede editar/descartar.
- Requiere relevar el form CGI de guardado (GET de `mipeGenFacEx.cgi`, sin POST)
  antes de implementar. Reusa `armarCamposEmision` del scraper de emisión.

### 3.3 BHE — emitir (alto riesgo, guardrail natural)

`POST /v1/bhe/emitir`
```
{ rut, receptor: { rut, nombre, domicilio, comuna, ... },
  detalle: [{ descripcion, valor }], fecha?, tipo_retencion?, confirmar? }
```
- `confirmar:false` → recorre pasos 1-3 y devuelve la previsualización (montos,
  retención, receptor) SIN emitir. `true` → paso 4 (emite, asigna folio) y
  opcionalmente paso 5 (email).
- Propaga el campo `tiempo` del server entre pasos. Valida la regla "no a uno
  mismo" antes de llamar al SII.

### 3.4 BHE — anular / observar / email (alto riesgo, inferido)

`POST /v1/bhe/anular` `{ rut, folio, causa, confirmar? }`
`POST /v1/bhe/observar` `{ rut, emisor, numero, causa, confirmar? }`
`POST /v1/bhe/email` `{ rut, codigo, email, confirmar? }`
- Requieren relevar el form CGI real (GET, sin ejecutar) antes de implementar.
- `anular` consulta el estado de la boleta antes de mutar (idempotencia:
  `ActoYaRealizado` si ya está anulada). Relevar la anulación además resuelve el
  `estado` de boleta anulada que hoy `bhe.ts` no captura.

---

## 4. Orden de implementación propuesto (por riesgo creciente)

1. **RCV acuse** — facade limpio, params confirmados, reversible, sin recaptcha.
   Primer PR: establece el guardrail (`confirmar`, errores tipados) que el resto
   reutiliza.
2. **Mipyme borrador** — reversible; primero relevar el form de guardado.
3. **BHE emitir** — con el dry-run como red; se verifica con una boleta de
   prueba y OK del usuario.
4. **BHE anular / observar / email** — tras relevar sus forms; los de mayor
   impacto (anular) quizá sólo REST, no MCP.

Fuera de R11: RCV `set_tipo_transaccion` (app legacy, redirect) y `set_resumen`
(no existe).

---

## 5. Lo que NO hace este diseño

- No persiste borradores ni estado de escritura en Neon: el SII es el dueño.
- No reintenta escrituras: un reintento puede duplicar un acto.
- No automatiza la clasificación de tipo de transacción del RCV (otro sistema).
- No toca eboleta (39/41): es otro mundo, fuera del alcance de BHE.

---

## 6. Preguntas abiertas para el revisor

1. ¿Emitir/anular BHE quedan sólo en REST (fuera de MCP) por su irreversibilidad?
2. ¿La ventana de idempotencia en memoria alcanza, o se quiere persistir una
   traza de escrituras (auditoría) aunque el servicio sea stateless para lo demás?
3. ¿Se arranca por RCV acuse (menor riesgo) como primer PR, confirmando el
   guardrail, antes de tocar BHE?
