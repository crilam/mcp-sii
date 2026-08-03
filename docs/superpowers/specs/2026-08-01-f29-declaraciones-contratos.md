# Contratos de las declaraciones F29

Fecha: 2026-08-01
Estado: esquema verificado; acceso a empresas **bloqueado por autorización de sesión**

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

## El bloqueo: autorización a nivel de sesión

Consultar una **empresa** devuelve un error de negocio, no de formato:

```json
{"data": null, "errors": [{"id":"0","descripcion":"Ocurrio un error de negocio. Consulta RUT[...] no esta autorizado"}]}
```

La causa está en el cliente: arma el objeto con `rut: sdiSession.rut, dv: sdiSession.dv`. O sea, **el RUT no es un parámetro libre: es el RUT que la sesión representa.** El backend valida que coincidan.

Esto contrasta con el Registro de Compras y Ventas, donde `rutEmisor` **sí** es un parámetro libre y basta con estar autorizado. Son dos modelos de autorización distintos dentro del mismo portal:

| Aplicación | Modelo |
|---|---|
| `consdcvinternetui` (RCV) | La empresa es parámetro del método |
| `propuestaf29ui` (F29) | La empresa es estado de la sesión |

## Qué falta — actualizado el 2026-08-03

Para consultar el F29 de una empresa hay que **establecer una sesión que la represente**. Ver [representación de empresa](2026-08-01-representacion-empresa.md), donde el relevamiento está parcialmente hecho.

**Conviene separar lo verificado de lo que no lo está**, porque de eso depende cuánto trabajo queda:

| Pieza | Estado |
|---|---|
| Acceso a la aplicación (puente `legacy/bridge2`) | **verificado** |
| Listar representados (`getRepresentantes`) | **verificado** |
| Establecer la sesión representada (`urlApplicacion`) | **sin verificar** |
| Origen del `clientId` que ese POST requiere | **sin resolver** |
| `code_app` de la propuesta F29 | **sin resolver** |

**Hay un bloqueo de registro, y podría haber además uno técnico.** Se accedió al registro de representantes y devolvió `total: 0`: el RUT probado no tiene ningún representado inscrito en ese sistema. Opera esas empresas por otros mecanismos —la lista del portal mipyme, la autorización del RCV— pero no como representante electrónico registrado.

Eso explica sin misterio por qué el RCV funciona y la propuesta F29 no: el RCV valida contra su propia lista de empresas autorizadas, mientras que la propuesta F29 valida contra el RUT que la sesión representa, que hoy es sólo el propio.

Un dato relacionado que sigue vigente: la lista de empresas del portal mipyme **no coincide** con la de otras aplicaciones — en la cuenta probada, mipyme lista 5 y el RCV habilita 17. La empresa consultada estaba entre las 17, no entre las 5. Cada aplicación tiene su propia noción de autorización.

Mientras la representación no esté inscrita, el cruce entre lo registrado en el RCV y lo declarado en el F29 no se puede completar. El lado registrado funciona hoy; el declarado, no.

## Recomendación

No construir `sii_f29_*` todavía. El esquema está resuelto, pero sin representación inscrita la tool sólo serviría para el RUT de la persona autenticada — que es justamente quien no declara F29.

El próximo paso es inscribir la representación electrónica en el SII, que es un trámite. **Pero eso es necesario, no necesariamente suficiente.**

Con la representación inscrita, `getRepresentantes` debería listarla y ahí recién se puede ejercitar `urlApplicacion` — que sigue sin verificar y que exige un `clientId` cuyo origen no se determinó y un `code_app` que tampoco. O sea: después del trámite queda trabajo técnico, de tamaño desconocido hasta poder probarlo.

Lo que sí está resuelto y no hay que volver a hacer es el **acceso** a la aplicación: autenticar legacy, cruzar el puente `legacy/bridge2`, y usar los dos juegos de cookies.
