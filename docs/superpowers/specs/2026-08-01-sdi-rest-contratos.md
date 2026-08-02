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

## El charset varía por aplicación

Corrección (2026-08-02, medido en vivo). Se venía asumiendo que el SII responde
ISO-8859-1 en todo, **incluidas las respuestas que declaran JSON**. Es falso: el
charset varía por aplicación y hay que respetar el `Content-Type` de cada
respuesta.

| Aplicación | `Content-Type` observado |
|---|---|
| Registro de Compras y Ventas (`consdcvinternetui`) | `application/json;charset=utf-8` |
| Renta F22 (`consultaestadof22ui`) | `application/json;charset=ISO-8859-1` |
| CGI legacy (BHE, `loa.sii.cl`) | ISO-8859-1 (no siempre declarado) |

Dos aplicaciones del mismo portal, con charsets distintos. Fijar cualquiera de
los dos para todo rompe la otra: `sii_rcv_resumen` devolvía
`"tipoDocNombre": "Factura ElectrÃ³nica"` porque los bytes `C3 B3` de la `ó` en
UTF-8 se leían de a uno como latin1.

**Default cuando no viene charset declarado: ISO-8859-1**, no UTF-8. Los CGI
legacy responden ISO-8859-1 y muchos no lo declaran; ahí un `0xF3` suelto sólo
es `ó` leído como latin1, y como UTF-8 es un byte inválido. Un default UTF-8
corrompería justamente los casos que no se pueden verificar por header.

La decodificación usa `TextDecoder` (nativo en Node, sin dependencias), con el
label tal como viene en el header: así queda cubierto cualquier charset que el
SII declare, sin mantener un mapa de equivalencias a mano. Dos consecuencias a
tener presentes:

- `windows-1252` se decodifica de verdad, no aproximado a latin1. Difieren en
  `0x80–0x9F`: ahí windows-1252 tiene imprimibles (`€`, comillas tipográficas,
  rayas) y latin1 controles C1, así que aproximar corrompía en silencio.
- Por la tabla WHATWG que sigue `TextDecoder`, el label `iso-8859-1` es alias de
  windows-1252 — el mismo comportamiento que cualquier navegador contra el
  portal. Los acentuados (`0xC0–0xFF`) son idénticos en ambas tablas.

Un label que `TextDecoder` no reconoce no voltea la consulta: se cae al default
y se avisa por stderr.

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
