# Representación de empresa: el puente legacy y el registro vacío

Fecha: 2026-08-01, **corregido el 2026-08-03**
Estado: **acceso verificado; el flujo de autorización, no**. Hay un bloqueo de registro y podría haber además uno técnico.

Spike para destrabar el F29 de empresa, que quedó pendiente porque `propuestaf29ui` trata la empresa como estado de sesión y no como parámetro (ver [contratos F29](2026-08-01-f29-declaraciones-contratos.md)).

## Corrección de la versión anterior

La primera versión de este documento afirmaba que la aplicación de representantes **no aceptaba las cookies legacy** y que el mecanismo era **no ejecutable con la autenticación actual**. **Las dos afirmaciones eran falsas**, por dos errores de la spike original:

1. **Ruta mal construida.** El bundle hace `userSessionDV = e.userId`, y se interpretó por el nombre de la variable que era el dígito verificador. Es el **RUT completo con DV**. Se estuvo consultando `/admin-representantes/4/...` cuando la ruta correcta es `/admin-representantes/11111111-1/...`.
2. **La spike se cortó antes de encontrar el puente.** Existe `/app/session/legacy/bridge2/`, que convierte una sesión legacy en una sesión de la pila nueva. No se encontró porque la exploración se detuvo al concluir que el `clientId` era inalcanzable.

La lección general: un `401` no prueba que la autenticación sea incompatible. Puede ser una ruta mal armada. Conviene descartar el error propio antes de declarar un límite ajeno.

## Las tres generaciones del portal

| Generación | Ejemplo | Autenticación |
|---|---|---|
| CGI legacy | `loa.sii.cl/cgi_IMT/` (BHE) | Cookies de sesión |
| SPA + sobre SDI | `www4.sii.cl/*ui/` (F22, RCV) | Cookies + `TOKEN` como `conversationId` |
| App moderna | `www2.sii.cl/admin-representantes` | Cookies legacy **más** estado del puente |

La tercera no exige un handshake OAuth propio: exige un paso extra sobre la sesión que ya se tiene.

## La receta, verificada

```
1. Autenticar legacy con certificado
   → cookies NETSCAPE_LIVEWIRE.*, TOKEN, CSESSIONID

2. GET https://www2.sii.cl/app/session/legacy/bridge2/?originalUrl=<destino urlencoded>
   → responde 307 y emite:
        X-SII-STATE-TYPE=CL
        X-SII-STATE-CL=<blob cifrado, ~1100 caracteres>

3. Usar AMBOS juegos de cookies contra /app/...
```

**El puente es imprescindible.** Verificado con un control sobre el mismo request, cambiando sólo las cookies de estado:

| Cookies | Respuesta |
|---|---|
| Sólo legacy | `401` |
| Legacy + `X-SII-STATE-*` | `200` |

Nota operativa: `curl -c` **no guarda** las cookies `X-SII-STATE-*` en el cookie jar. Hay que leerlas de los headers de respuesta y agregarlas a mano. Quien implemente esto va a perder tiempo si no lo sabe.

## El estado de la sesión nueva

`GET /app/session/status?originalUrl=<url>` funciona **con las cookies legacy solas**, sin el puente:

```json
{ "seconds": 5999, "userId": "11111111-1", "userProfiles": ["00000"],
  "userAuthType": "CT", "authTime": 1785602849, "userRte": "11111111-1" }
```

O sea que la pila nueva **nunca rechazó el certificado**. Reconoce la sesión y la reporta como `userAuthType: "CT"`.

**No devuelve `clientId`**, que es el campo que el bundle lee (`this.client_id = e.clientId`) para armar la llamada de autorización. Queda sin determinar si aparece por otra vía.

## Los endpoints

Base: `https://www2.sii.cl/app/admin-representantes/{RUT-con-DV}/`
Microservicio detrás (revelado por un error 500): `admin-representantes-ms`

### Listar representados — verificado

```
GET .../representante/v1/{tipo}/getRepresentantes/{RUT-sin-DV}?pageNo=0&pageSize=20
```

`{tipo}` es `consulta_rpte` o `consulta`. **Sólo `consulta_rpte` responde**; `consulta` devuelve `500` para el RUT probado.

Respuesta:

```json
{ "pageable": { "pageSize": 20, "pageNumber": 0, ... },
  "total": 0, "representadosDto": [],
  "rut": 11111111, "name": "JUAN PEREZ SOTO" }
```

### Establecer la representación — sin verificar

```
POST .../authorize/v1/{tipo}/urlApplicacion
{ "rut_rpte": "...", "rut_rdo": "...", "client_id": "...", "code_app": "...", "state": "<uuid>" }
→ { "success": true, "url": "..." }
```

El cliente navega a esa `url` y con eso la sesión pasa a actuar como la empresa representada, **para la aplicación indicada en `code_app`**. La representación no es global: se otorga por aplicación destino.

No se pudo ejercitar por lo que sigue.

## El hallazgo que reemplaza el diagnóstico

**`total: 0`.** El RUT probado **no tiene ningún representado registrado en este sistema**.

Eso cambia la naturaleza del bloqueo del F29 de empresa. No es una barrera técnica: es un registro vacío. La persona opera esas empresas por **otros mecanismos** —la lista del portal mipyme, la autorización del Registro de Compras y Ventas— pero no está inscrita como *representante electrónico* en este registro más nuevo.

La consecuencia práctica cambia respecto de la versión anterior, pero con un matiz que conviene no perder: hay que inscribir la representación en el SII —un trámite— y **eso es necesario, no necesariamente suficiente**. El POST que establece la sesión representada sigue sin verificarse, y exige un `clientId` cuyo origen no se determinó. Puede que después del trámite quede trabajo técnico; hoy no hay forma de saber cuánto sin poder ejercitarlo.

Esto también explica por qué el RCV funciona y la propuesta F29 no, sin necesidad de invocar dos modelos de autorización distintos: el RCV valida contra su propia lista de empresas autorizadas, y la propuesta F29 valida contra el RUT que la sesión representa — que hoy es sólo el propio.

## Lo que queda sin verificar

1. **El `clientId`.** El bundle lo espera y `session/status` no lo devuelve. Puede venir de otra llamada, o el campo puede ser opcional en la práctica.
2. **`authorize/v1/urlApplicacion`.** Con cero representados no hay nada que autorizar.
3. **El `code_app` de la propuesta F29**, que sale de un listado que la app obtiene autenticada.
4. **Si `consulta` (sin `_rpte`) sirve para otro caso** o su `500` es un defecto del servicio.

## Qué recomienda este documento ahora

La versión anterior planteaba elegir entre relevar un handshake OIDC —caro— o acumular claves tributarias de empresas —riesgoso—. **Las dos opciones partían de una premisa falsa.**

El camino correcto, si se quiere consultar el F29 de una empresa:

1. **Inscribir la representación electrónica en el SII.** Es un trámite. Sin eso no hay nada que autorizar y el resto no se puede probar.
2. **Recién entonces terminar el relevamiento**: ejercitar `urlApplicacion`, resolver de dónde sale el `clientId` y cuál es el `code_app` de la propuesta F29. Ese trabajo es técnico y su tamaño es desconocido hasta poder intentarlo.
3. Después implementar.

Lo que **no** hay que volver a hacer es el acceso a la aplicación: eso quedó resuelto con el puente.

La opción de autenticar directamente con la clave tributaria de la empresa sigue existiendo, pero deja de ser el camino barato frente a un obstáculo técnico: pasa a ser un atajo alrededor de un trámite, con las consecuencias de custodia y de alcance de escritura que eso implica.

## Valor más allá del F29

El puente `legacy/bridge2` probablemente destrabe **cualquier** aplicación de tercera generación del portal, no sólo la de representantes. Es un paso genérico sobre la sesión, no algo específico de este dominio.

Si aparecen más aplicaciones sobre esa pila —y la tendencia del portal indica que van a aparecer—, el trabajo de acceso ya está hecho: autenticar legacy, cruzar el puente, y usar los dos juegos de cookies.
