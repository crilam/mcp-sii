# Representación de empresa: el mecanismo y por qué no alcanza con las cookies

Fecha: 2026-08-01
Estado: mecanismo identificado, **no ejecutable con la autenticación actual**

Spike acotada para destrabar el F29 de empresa, que quedó bloqueado porque `propuestaf29ui` trata la empresa como estado de sesión y no como parámetro (ver [contratos F29](2026-08-01-f29-declaraciones-contratos.md)).

## Resultado en una línea

El mecanismo existe y quedó mapeado, pero vive sobre una **pila de identidad distinta** de la que usa el resto del MCP. No es cuestión de agregar un parámetro: es otro sistema de autenticación.

## Tres pilas de tecnología, no dos

El portal ya mostraba dos generaciones —CGI legacy y SPA sobre el sobre SDI—. Esta spike encontró una tercera:

| Generación | Ejemplo | Autenticación |
|---|---|---|
| CGI legacy | `loa.sii.cl/cgi_IMT/` (BHE) | Cookies de sesión |
| SPA + sobre SDI | `www4.sii.cl/*ui/` (F22, RCV) | Cookies + cookie `TOKEN` como `conversationId` |
| **App moderna** | `www2.sii.cl/admin-representantes` | **OAuth/OIDC con `clientId`** |

La tercera es una aplicación Vite (Vue) con cliente axios, y **no acepta las cookies legacy**: las llamadas a su API devuelven `401`.

## El mecanismo de representación

Dos endpoints, extraídos del bundle.

### Listar representados

```
GET /app/admin-representantes/{DV}/representante/v1/{tipo}/getRepresentantes/{RUT}
    ?pageNo=0&pageSize=10
```

`{tipo}` es `consulta` o `consulta_rpte`, según se consulte como representado o como representante. Devuelve `representadosDto`.

### Obtener la URL que establece la representación

```
POST /app/admin-representantes/{DV}/authorize/v1/{tipo}/urlApplicacion
{
  "rut_rpte":  "<RUT del representante>",
  "rut_rdo":   "<RUT del representado>",
  "client_id": "<de la sesión>",
  "code_app":  "<código de la aplicación destino>",
  "state":     "<uuid>"
}
```

Responde `{success, url}`, y el cliente hace `window.location.href = url`. Esa navegación es la que deja la sesión actuando como la empresa representada, **para la aplicación indicada en `code_app`**.

Es decir: la representación **no es global**, se otorga por aplicación destino. Eso encaja con lo observado antes — el Registro de Compras y Ventas funciona sin representación porque su modelo de autorización es distinto, mientras que la propuesta F29 la exige.

## Por qué no se pudo ejecutar

Los dos valores que faltan no son constantes:

- **`client_id`** sale de `$getSession().clientId`, un store persistido que llena un handshake previo de OAuth/OIDC. No está en el bundle ni en ninguna cookie legacy.
- **`code_app`** es el código de la aplicación destino, tomado de un listado que la propia app obtiene autenticada.

Sin resolver el handshake de identidad, ambos son inalcanzables. Y ese handshake es un sistema completo —no un parámetro— que habría que relevar por separado.

## Qué significa para el proyecto

**Se cierra el camino corto al F29 de empresa.** No hay un ajuste chico que lo destrabe.

Quedan dos opciones reales, y conviene elegirla como decisión de diseño:

1. **Relevar el handshake OAuth/OIDC del SII.** Es la solución general: destrabaría todas las aplicaciones de tercera generación, que presumiblemente serán más con el tiempo. Es también la más cara, y depende de un sistema que el SII puede cambiar sin aviso.
2. **Autenticar directamente como la empresa**, con su propio RUT y clave tributaria. Evita la representación por completo: si la sesión ya *es* la empresa, `sdiSession.rut` coincide y `propuestaf29ui` responde.

La opción 2 es mucho más barata, pero tiene consecuencias que no son técnicas:

- **El código de hoy asume una sola identidad.** `SiiConfig` tiene un `SII_RUT` y un `SII_CLAVE`. Soportar varias exige rediseñar `env.ts` y `SessionManager`, decidir qué identidad usa cada tool, y administrar pools de sesión separados — el SII cuenta las sesiones por RUT.
- **Una clave tributaria de empresa habilita actos de escritura** con consecuencias económicas y legales: declarar F29, emitir documentos, presentar declaraciones juradas. Cualquier tool que lea `SII_CLAVE` la alcanzaría, incluidas las de escritura que ya existen. Si se toma este camino, conviene separar credenciales de lectura de las de escritura, o poner las de escritura detrás de un flag explícito.

## Lo que sí quedó disponible

El **Registro de Compras y Ventas funciona hoy** para cualquier empresa autorizada, sin representación y sin credenciales nuevas, porque su modelo trata la empresa como parámetro. Cubre lo registrado —compras, ventas, IVA débito y crédito por período—, que es la mitad del cruce que se buscaba.

Lo que no se puede sin resolver lo anterior es la otra mitad: lo declarado.
