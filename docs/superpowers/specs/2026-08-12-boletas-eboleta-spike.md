# Boletas electrónicas (39/41): no es el mismo SII

Fecha: 2026-08-12
Estado: **spike inicial de lectura.** Ningún documento emitido, ninguna escritura. La pregunta que decide la viabilidad quedó identificada y sin responder.

Spike para el gateway de boletas de Parkingapp, que es la meta real detrás de la
migración del portal mipyme. Continúa el [contrato de emisión de mipyme](2026-08-03-mipyme-http-contratos.md).

## El portal mipyme no emite boletas

Primer hallazgo, y ya invalida el plan implícito de "reusar lo de las facturas".
El menú del portal de facturación (`/factura_sii/factura_sii.htm`) ofrece
factura, exenta, guía, factura de compra, liquidación, exportación y notas —
**ninguna boleta**. Su único enlace de boletas es
`mipeSelEmpresaBol.cgi`, que sirve para emitirles **nota de crédito**, no para
emitirlas.

La emisión de boletas vive en **`https://eboleta.sii.cl/`**, una aplicación
aparte. Nada del scraper de mipyme aplica: ni el parseo de HTML malformado, ni
las entidades numéricas, ni el ISO-8859-1, ni la página de firma con
certificado. **Todo eso muere en el portal mipyme.**

## eboleta es una SPA sobre AWS, no un CGI del SII

`GET https://eboleta.sii.cl/` devuelve 1,3 KB: el HTML de una SPA Vue. Toda la
funcionalidad está en `/js/app.js` + `/js/chunk-vendors.js`, y las llamadas van
a **API Gateway de AWS**, no a `www1.sii.cl`.

La configuración de Amplify está embebida en el bundle:

```js
aws_project_region: "us-east-1",
aws_cognito_identity_pool_id: "us-east-1:e154b392-0e4e-47ad-a68f-5c814f8e3eb5",
aws_user_pools_id: "us-east-1_6cKII12uo",
aws_user_pools_web_client_id: "10bbim766s7jvka7ibatpmsr39",
aws_cloud_logic_custom: [
  { name: "apiAuthSII",             endpoint: "https://x78kr8nqx5.execute-api.us-east-1.amazonaws.com/prod" },
  { name: "apiBoletaSII",           endpoint: "https://q0pwrt48l5.execute-api.us-east-1.amazonaws.com/prod" },
  { name: "apiConfiguracion",       endpoint: "https://76n86hwd0g.execute-api.us-east-1.amazonaws.com/prod" },
  { name: "apiConfiguracionUsuario",endpoint: "https://cunz2isut6.execute-api.us-east-1.amazonaws.com/prod" },
  { name: "eBoletaActualizador",    endpoint: "https://tz246sanri.execute-api.us-east-1.amazonaws.com/prod" },
  { name: "notificaciones",         endpoint: "https://s0p3uy3jwi.execute-api.us-east-1.amazonaws.com/prod" },
]
```

Endpoints vistos en el bundle:

```
POST /api/dte/documentos/generar                    ← la emisión
GET  /api/info-contribuyente/emisores-usuario/:rut
GET  /api/info-contribuyente/info-emisor-usuario/:rut/:x
GET  /api/info-contribuyente/info-receptor/:rut
```

Y el modelo de datos del documento, que es una clase con validación en el
cliente: `tipoDte` (39 boleta afecta, 41 boleta exenta), `emisor`, `receptor`,
`detalle`, `vendedor`, `meta`.

**Dato que importa para Parkingapp**: el bundle trae un receptor por defecto
`{RUT: 66666666, DV: 6, RAZON_SOCIAL: "SII Boleta", COMUNA: "Santiago"}` — el
receptor genérico de las boletas sin receptor identificado, que es exactamente
el caso de un estacionamiento.

## La autenticación es SigV4, no un cookie jar

Es el hallazgo que decide todo. El cliente HTTP del bundle es el `RestClient` de
Amplify, con `service: "execute-api"` y `Credentials` de Cognito: **cada llamada
va firmada con SigV4** usando credenciales temporales de AWS.

Medido: los seis endpoints con el cookie jar del certificado digital responden

```
403 {"message":"Missing Authentication Token"}
```

En API Gateway ese mensaje es ambiguo —también aparece cuando la ruta no
existe—, así que **no prueba** que el path esté mal ni que la credencial sea el
problema; lo que sí está claro por el bundle es que sin firma SigV4 no se entra.

Consecuencia para el gateway: **el cookie jar del SII no sirve acá**. Hace falta

1. autenticarse contra el SII (la SPA redirige a `clave.w.sii.cl/oauthsii-v1`
   con `client_id=e0378e96-4014-4a47-b852-9d9246797f5c` y
   `redirect_uri=https://eboleta.sii.cl/emitir/`),
2. convertir eso en una sesión de Cognito (user pool `us-east-1_6cKII12uo`), y
3. obtener credenciales AWS del identity pool para firmar SigV4.

## La pregunta abierta, que es la única que importa

**¿Cómo se pasa del login del SII a las credenciales de Cognito?** Hay una API
llamada `apiAuthSII` que casi con seguridad hace ese intercambio, pero su
contrato no se relevó.

De la respuesta salen las dos ramas posibles:

- **Si el intercambio es un POST replicable** (código OAuth o token del SII →
  tokens de Cognito), el gateway es viable y además *más simple* que el de
  facturas: API JSON, sin HTML, sin firma con certificado, con un endpoint
  `documentos/generar` explícito.
- **Si exige el flujo interactivo del navegador** (redirects, PKCE con estado en
  el cliente), el gateway necesita un navegador headless para obtener la sesión
  y renovarla, y eso cambia la arquitectura y el costo operativo.

Se responde observando el tráfico de un login real en el navegador —qué se
postea a `apiAuthSII` y qué devuelve—, que es lectura y no emite nada.

## Lo que falta

1. **El intercambio OAuth → Cognito** (arriba). Bloquea todo lo demás.
2. El contrato de `POST /api/dte/documentos/generar`: forma del cuerpo y si hay
   un paso de previsualización como en las facturas.
3. Si la emisión de boleta también exige firma con certificado. En el portal
   mipyme sí; acá el bundle no muestra ningún plugin de firma, lo que sugiere
   que **el SII firma del lado servidor** — sería una diferencia grande a favor.
4. Confirmar el alta de TRUFUL para boleta gratuita. El 2026-08-11 la app
   respondía "NO SE ENCONTRÓ LA PÁGINA" tras el redirect; el 2026-08-12
   `GET https://eboleta.sii.cl/` responde 200 con el HTML de la SPA. Eso sugiere
   que el alta se activó, pero **no lo prueba**: 200 en el HTML de una SPA no
   dice nada de los permisos, que viven detrás de las APIs.

## Recomendación

Tratarlo como un proyecto separado del scraper de mipyme, con su propio
transporte (SigV4 + Amplify o SDK de AWS) y su propia sesión. Reusar de este
repo `SessionManager` para el login del SII y nada más.

No empezar a escribir código hasta responder el punto 1: la arquitectura del
gateway depende de esa respuesta, y escribir el cliente antes obliga a
reescribirlo si la respuesta es la rama interactiva.
