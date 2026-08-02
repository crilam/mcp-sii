# El sobre SDI: cómo se consumen las APIs REST modernas del SII

Fecha: 2026-08-01
Estado: verificado en vivo contra `consultaestadof22ui`

Resultado de la spike previa a la Fase 2 (renta F22). El hallazgo excede esa fase: es el contrato de **todas** las aplicaciones modernas del portal, las que viven en `www4.sii.cl/<app>ui/`.

## El problema que resuelve

El recorrido inicial del portal encontró que estas aplicaciones exponen APIs REST JSON, que rechazan GET con `405` y responden a POST. Pero un POST con cuerpo `{}` devolvía `{"data":null,"respCod":2}` y con campos inventados un error de formato. El contrato parecía descubrible sólo a fuerza de adivinar nombres de parámetros.

No era eso. Faltaba el sobre.

## El sobre

Todas estas aplicaciones usan un framework interno del SII —lo llaman SDI— cuyo cliente construye así cada petición:

```json
{
  "metaData": {
    "namespace": "<interfaz Java>/<método>",
    "conversationId": "<valor de la cookie TOKEN>",
    "transactionId": "<identificador único por petición>",
    "page": null
  },
  "data": { ...parámetros del método... }
}
```

Con `Content-Type: application/json` y las cookies de sesión. Los parámetros del método van **anidados dentro de `data`**, no en la raíz — por eso fallaban las pruebas anteriores.

### De dónde sale cada campo

- **`namespace`**: está en el bundle minificado de cada aplicación, en las llamadas a `createServiceOperation(...)`. Para F22 es `cl.sii.sdi.lob.renta.consultaestadof22.data.api.interfaces.FacadeService/<método>`. Cada aplicación tiene el suyo, y sigue el patrón `cl.sii.sdi.lob.<dominio>.<app>.data.api.interfaces.<Servicio>/<método>`.
- **`conversationId`**: el valor de la cookie `TOKEN`. Confirmado en `/common-1.0/js/sii/settings.js`, que hace `token = getCookie('TOKEN')` cuando no hay sesión Angular en memoria.
- **`transactionId`**: identificador por petición. El cliente del portal genera un UUID; en las pruebas funcionó cualquier cadena única.
- **`page`**: `null` salvo en endpoints paginados.

Si el sobre está incompleto, la respuesta es `{"errorMsg": "Acceso no autorizado!"}` — un mensaje que apunta a un problema de permisos cuando en realidad es de formato. Vale tenerlo presente: es un error engañoso.

## Códigos de respuesta observados

| Respuesta | Significado |
|---|---|
| `data` con contenido, sin `respCod` | Éxito |
| `respCod: 2`, `data: null` | Sin datos para esos parámetros |
| `errorMsg: "Acceso no autorizado!"` | Sobre mal formado, **no** un problema de permisos |
| `errorMsg: "Solicitud inválida. Formato incorrecto..."` | `data` con campos que el método no reconoce |

La distinción entre las dos primeras filas es la de siempre en este proyecto: **`respCod: 2` es un vacío legítimo, no un error.** Un año sin declaración y una declaración sin observaciones responden igual que una consulta correcta que no encontró nada.

## Contratos verificados (F22)

Base: `https://www4.sii.cl/consultaestadof22ui/services/data/facadeService/`
Namespace: `cl.sii.sdi.lob.renta.consultaestadof22.data.api.interfaces.FacadeService`

| Método | `data` | Devuelve | Estado |
|---|---|---|---|
| `buscaDeclVgte` | `{rut, dv, periodo}` | `{decls: [...]}` con folio, nombres, comuna, dirección, estado de la declaración | **verificado** |
| `f22Completo` | `{rut, dv, folio, periodo}` | Lista de 76 objetos `{codigo, valor, glosa}` — el formulario 22 completo | **verificado** |
| `buscaObservacion` | `{rut, dv, folio, periodo}` | `respCod: 2` en la declaración probada | **inferido** |
| `consultarPeriodo` | desconocido | — | **por descubrir** |

`rut` va **sin** dígito verificador y `dv` aparte. `periodo` es el año tributario como cadena.

### Sobre `buscaObservacion`

Devolvió `respCod: 2` con los mismos parámetros que funcionaron para `f22Completo`. Las dos lecturas posibles son "esta declaración no tiene observaciones" y "los parámetros no son los correctos", y **no se puede distinguir con una sola declaración limpia**. Hace falta probarlo contra una declaración observada antes de darlo por bueno.

Mientras tanto, una tool construida sobre esto reportaría "sin observaciones" ante un error de parámetros — exactamente el fallo silencioso que el proyecto viene evitando. Es la razón para dejarlo como *inferido* y no construir encima todavía.

## Por qué esto importa más allá de la Fase 2

El mismo sobre sirve para el resto de las aplicaciones modernas del portal: carpeta tributaria, bienes raíces, tasación de vehículos, beneficio del adulto mayor, impuesto a bienes de alto valor. Cambia el `namespace` y la base de la URL; la mecánica es idéntica.

Consecuencia para el diseño: `SiiHttpClient` debería ganar un método que arme el sobre —algo como `postSdi(url, namespace, data)`— en vez de que cada scraper lo replique. Y la resolución del `conversationId` desde la cookie `TOKEN` pertenece al cliente, que ya es quien conoce el cookie jar.

## Lo que falta

1. **Verificar `buscaObservacion` contra una declaración observada.** Sin eso, la tool de observaciones no se puede entregar con confianza.
2. **`consultarPeriodo`**: no se determinaron sus parámetros. Puede ser innecesario si `buscaDeclVgte` ya cubre el caso.
3. **`djconsultarentaui`** (ingresos y agentes retenedores) es otra aplicación, con su propio namespace y base, todavía sin relevar. Ojo: su raíz ejecuta JavaScript que borra las cookies de sesión — inofensivo por HTTP, letal por navegador.
4. **Los endpoints de PDF** usan `createSpecialServiceOperation`, con el mismo sobre pero `responseType: arraybuffer`. Quedan fuera del alcance acordado.
