# Representación de empresa: el puente legacy y el registro vacío

Fecha: 2026-08-01, **corregido dos veces el 2026-08-03**
Estado: **la representación electrónica no es el camino del proyecto.** El acceso a la aplicación quedó verificado y ese hallazgo sigue sirviendo; el flujo de autorización no se verificó y ya no hace falta.

Spike para destrabar el F29 de empresa, que quedó pendiente porque `propuestaf29ui` trata la empresa como estado de sesión y no como parámetro (ver [contratos F29](2026-08-01-f29-declaraciones-contratos.md)).

## Segunda corrección: la representación resuelve un problema que el proyecto no tiene

Este documento —en las dos versiones anteriores— asumía que operar una empresa exigía **representarla desde la identidad de una persona**. Toda la spike, y su recomendación de inscribir un trámite, salen de ahí.

**El modelo del proyecto es otro.** La lista de empresas la define el servicio, y para cada empresa administrada se cuenta con **su RUT y su clave del SII**. Se autentica *como* la empresa. `propuestaf29ui` valida contra el RUT que la sesión representa, y con credenciales propias ese RUT ya es el de la empresa: no hay nada que representar.

Consecuencia sobre lo que sigue de este documento:

| Parte | Sigue válida |
|---|---|
| Las tres generaciones del portal | **sí** |
| El puente `legacy/bridge2` y su receta | **sí** — es genérico, sirve con cualquier sesión |
| `GET /app/session/status` | **sí** |
| `getRepresentantes` y el `total: 0` | sí como dato, **irrelevante** para el proyecto |
| `authorize/v1/urlApplicacion`, `clientId`, `code_app` | **no hacen falta**: son maquinaria para representar a un tercero |
| La recomendación de inscribir la representación | **descartada** |

Dónde está el bloqueo real del multi-empresa, entonces: en **una credencial y una sesión por identidad**. Hoy `env.ts` toma un único juego y `server.ts` comparte un `SessionManager` —porque dos sesiones simultáneas contra el mismo RUT disparan el bloqueo del SII—, y un Chrome con un solo almacén de cookies no sostiene dos identidades. Eso hace de la migración de `mipyme.ts` a HTTP un prerrequisito, y de la custodia de las claves una decisión de seguridad a tomar explícitamente. Ver [estado y pendientes](2026-08-03-estado-y-pendientes.md).

La lección de método, que es la misma de la primera corrección con otro disfraz: **antes de relevar un mecanismo, verificar que el problema que resuelve sea el que se tiene.** Esta spike relevó bien un camino que no había que tomar.

## Primera corrección: el 401 no era incompatibilidad

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

La consecuencia práctica que se sacó de acá —inscribir la representación, un trámite— **quedó descartada por la segunda corrección**: con clave propia de cada empresa no hay nada que representar. Se deja el hallazgo porque el `total: 0` explica el comportamiento observado, no porque marque un camino.

Esto también explica por qué el RCV funciona y la propuesta F29 no, sin necesidad de invocar dos modelos de autorización distintos: el RCV valida contra su propia lista de empresas autorizadas, y la propuesta F29 valida contra el RUT que la sesión representa — que hoy es sólo el propio.

## Lo que quedó sin verificar, y ya no hace falta

Se listan para cerrar el registro, no como pendientes. Los tres primeros sólo importan si algún día se quisiera representar a un tercero — no es el caso del proyecto:

1. **El `clientId`.** El bundle lo espera y `session/status` no lo devuelve.
2. **`authorize/v1/urlApplicacion`.** Con cero representados no había nada que autorizar.
3. **El `code_app` de la propuesta F29**, que sale de un listado que la app obtiene autenticada.
4. **Si `consulta` (sin `_rpte`) sirve para otro caso** o su `500` es un defecto del servicio. Éste es el único que podría reaparecer, si alguna vez se consume esta aplicación por otro motivo.

## Qué recomienda este documento ahora

**No tomar este camino.** Para consultar el F29 de una empresa se autentica con las credenciales de esa empresa; la representación electrónica sobra. El pendiente real es de arquitectura de sesión y de custodia de claves, y vive en [estado y pendientes](2026-08-03-estado-y-pendientes.md).

Lo que **sí** hay que conservar de esta spike es el acceso: autenticar legacy, cruzar el puente `legacy/bridge2`, y usar los dos juegos de cookies. Eso no depende de a quién represente la sesión.

## Valor más allá del F29

El puente `legacy/bridge2` probablemente destrabe **cualquier** aplicación de tercera generación del portal, no sólo la de representantes. Es un paso genérico sobre la sesión, no algo específico de este dominio.

Si aparecen más aplicaciones sobre esa pila —y la tendencia del portal indica que van a aparecer—, el trabajo de acceso ya está hecho: autenticar legacy, cruzar el puente, y usar los dos juegos de cookies.
