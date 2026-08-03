# Contratos de las declaraciones F29

Fecha: 2026-08-01, **corregido el 2026-08-03**
Estado: esquema verificado. La empresa es **estado de la sesión, no parámetro** — con credenciales propias de la empresa eso deja de ser un bloqueo y pasa a ser sólo un requisito sobre qué sesión se usa.

Spike acotada para cerrar el cruce "lo registrado contra lo declarado". Complementa los contratos del [Registro de Compras y Ventas](2026-08-01-f29-rcv-contratos.md).

## Dos caminos, uno viable

**La Consulta Integral F29** (`sifmConsultaInternet`) está construida en **GWT**, no en el framework SDI. Carga un `sifmConsulta.nocache.js` y habla un protocolo RPC posicional con firmas de tipo. Revertirlo es un trabajo de otro orden de magnitud que las apps SDI. **Descartada** salvo que no haya alternativa.

**`propuestaf29ui`** sí es SDI, y expone 59 métodos. Es el camino viable, y el que se relevó acá.

Advertencia sobre este servicio: entre sus 59 métodos hay varios de **escritura** con consecuencias tributarias reales — `declaracionSinPago`, `crearPagoPec`, `anularPec`, `generarDeclaracionCuponPago`, `enrolarContribuyente`. Cualquier tool construida acá debe declarar explícitamente que no los toca.

## La técnica: el servidor dicta su propio esquema

Ante un campo desconocido, este backend responde HTTP 400 con el nombre de la clase Java y del campo rechazado:

```
UnrecognizedPropertyException: Unrecognized field "dv"
(Class cl.sii.sdi.lob.iva.propuestaf29.data.api.model.data.business.DeclaracionData$DeclaracionVigente),
not marked as ignorable
```

Eso permite descubrir el esquema campo por campo. Pero **es el camino lento**: sale más barato leerlo del bundle minificado, donde el propio cliente construye el objeto. Los nombres de abajo salieron de ahí y se confirmaron después contra el servidor.

Conviene tener presente que cada clase tiene su propio esquema: `DeclaracionVigente` **rechaza** `dv`, mientras que `DeclaracionConEstado` lo **exige**. No hay un esquema único por servicio.

## Contrato verificado

Base: `https://www4.sii.cl/propuestaf29ui/services/data/facadeAdapterService/`
Namespace: `cl.sii.sdi.lob.iva.propuestaf29.data.api.interfaces.FacadeAdapterService`

### `getDeclaracionConEstados`

```json
{ "rut": "<RUT sin DV>", "dv": "<DV>", "formId": "2", "mes": "<MM>", "anno": "<AAAA>" }
```

**`formId` es `"2"`, no `"29"`.** Es el identificador interno del formulario, no su número. El bundle define aparte `FORMULARIO29: "29"`, que es otra cosa. Equivocarse acá no da error de formato: da un resultado vacío, que es peor.

Mes y año van **separados**, no como período `AAAAMM` — a diferencia del Registro de Compras y Ventas, que usa `ptributario: "AAAAMM"`. Dos aplicaciones del mismo dominio tributario con convenciones distintas.

Devuelve `data` como lista de declaraciones con su `estadoDeclaracionId`.

**Verificado:** con el RUT de la persona autenticada devuelve `data: []` con `errors: null` — un vacío legítimo y limpio.

### Estados de declaración

Constantes del bundle, necesarias para interpretar `estadoDeclaracionId`:

| Id | Estado |
|---|---|
| 1 | Vigente |
| 10 | Guardado RFI contribuyente |
| 12 | Pago rechazado |
| 40 | Guardado por el contribuyente |
| 41 | Datos guardados |
| 42 | En proceso de pago PEC |
| 43 | En proceso de pago PEEL |
| 44 | Guardado fiscalización |
| 48 | Ingreso sin movimiento |
| 50 | Giro pagado |
| 67 | Pendiente de anulación |
| 70 | Pago inconcluso |

## La empresa es estado de la sesión, no parámetro

Consultar una **empresa** desde la sesión de una persona devuelve un error de negocio, no de formato:

```json
{"data": null, "errors": [{"id":"0","descripcion":"Ocurrio un error de negocio. Consulta RUT[...] no esta autorizado"}]}
```

La causa está en el cliente: arma el objeto con `rut: sdiSession.rut, dv: sdiSession.dv`. O sea, **el RUT no es un parámetro libre: es el RUT que la sesión representa.** El backend valida que coincidan.

Esto contrasta con el Registro de Compras y Ventas, donde `rutEmisor` **sí** es un parámetro libre y basta con estar autorizado. Son dos modelos de autorización distintos dentro del mismo portal:

| Aplicación | Modelo |
|---|---|
| `consdcvinternetui` (RCV) | La empresa es parámetro del método |
| `propuestaf29ui` (F29) | La empresa es estado de la sesión |

## Qué falta — corregido el 2026-08-03

La versión anterior de esta sección concluía que había que **establecer una sesión que representara a la empresa**, y de ahí salía una recomendación de inscribir la representación electrónica —un trámite— antes de poder seguir. **Esa conclusión partía de un modelo equivocado del proyecto** y queda descartada.

El modelo real: la lista de empresas la define el servicio, y para cada empresa administrada se cuenta con **su RUT y su clave del SII**. Se autentica *como* la empresa, así que `sdiSession.rut` **ya es** el RUT de la empresa y el backend valida contra el valor correcto. El hallazgo de arriba —la empresa es estado de sesión, no parámetro— sigue siendo cierto; deja de ser un obstáculo y pasa a ser un requisito sobre con qué credenciales se abre la sesión.

Lo que eso **saca** del camino: `getRepresentantes`, `authorize/v1/urlApplicacion`, el `clientId` y el `code_app`. Todo eso era maquinaria para representar a un tercero. La spike que los relevó ([representación de empresa](2026-08-01-representacion-empresa.md)) conserva un hallazgo útil y sólo uno: el puente `legacy/bridge2`, que es genérico y da acceso a las aplicaciones de tercera generación con cualquier sesión.

Lo que **queda** por resolver antes de `sii_f29_*`, y es de arquitectura, no de contrato:

| Pieza | Estado |
|---|---|
| Esquema de `getDeclaracionConEstados` | **verificado** |
| Estados de declaración | **verificado** (del bundle) |
| Una credencial por empresa administrada | **sin implementar** — `env.ts` toma un único juego |
| Una sesión por identidad | **sin implementar** — `server.ts` comparte un `SessionManager` |
| Migración de `mipyme.ts` a HTTP | **pendiente**, y es prerrequisito: un Chrome con un almacén de cookies no sostiene dos identidades |
| Custodia de las claves de empresa | **decisión pendiente**, de seguridad |
| `getDeclaracionConEstados` con una sesión de empresa real | **sin ejercitar** |

Un dato relacionado que sigue vigente: la lista de empresas del portal mipyme **no coincide** con la de otras aplicaciones — en la cuenta probada, mipyme lista 5 y el RCV habilita 17. La empresa consultada estaba entre las 17, no entre las 5. Ninguna de esas listas es "la lista de empresas del usuario": importa al interpretar lo que devuelve cada aplicación, no al decidir qué se puede operar.

## Recomendación

**No construir `sii_f29_*` todavía, por una razón distinta a la anterior.** El esquema está resuelto y el camino ya no está bloqueado por un trámite; lo que falta es el soporte multi-identidad del servidor. Con la configuración de hoy —un solo juego de credenciales— la tool sólo serviría para el RUT de la persona autenticada, que es justamente quien no declara F29.

Orden sugerido:

1. Migrar `mipyme.ts` a HTTP (prerrequisito del multi-identidad).
2. Resolver credencial y sesión por empresa, respetando el candado contra sesiones simultáneas del mismo RUT.
3. Ejercitar `getDeclaracionConEstados` con una sesión de empresa real y capturar una fixture anonimizada.
4. Recién entonces implementar, con la advertencia de escritura de arriba explícita en la descripción de la tool.

Ver [estado y pendientes](2026-08-03-estado-y-pendientes.md) para cómo se ordena esto contra el resto del proyecto.
