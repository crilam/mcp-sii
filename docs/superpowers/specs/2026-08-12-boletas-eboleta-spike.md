# Boletas electrónicas (39/41): no es el mismo SII

Fecha: 2026-08-12
Estado: **pregunta de viabilidad RESUELTA.** Se observó un login real con captura de red (HAR): el intercambio del login del SII a credenciales de Cognito es una **cadena de POST replicable, sin navegador en runtime**. Ningún documento emitido, ninguna escritura. El gateway es viable y más simple que el de facturas.

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

## La respuesta: cadena de POST replicable (relevada en vivo con HAR)

Se capturó el tráfico de un login real (RUT + clave tributaria) el 2026-08-12. El
intercambio del login del SII a credenciales de AWS es **cuatro pasos, todos
POST, sin navegador ni PKCE con estado en el cliente**. Es la rama buena.

```
1. LOGIN (OAuth code)
   POST https://clave.w.sii.cl/oauthsii-v1-ms/authorization/v1/authorize
   Content-Type: application/json
   { "response_type":"code", "client_id":"e0378e96-4014-4a47-b852-9d9246797f5c",
     "redirect_uri":"https://eboleta.sii.cl/emitir/", "scope":"user_info",
     "state":"<uuid>", "user":"<rut sin dv>", "password":"<clave tributaria>",
     "token_captcha":"0", "action_captcha":"login" }
   → el `code` (un uuid) vuelve para redirigir a redirect_uri?code=<uuid>&state=<state>.
     (Clave mala → 200 {"success":false,"code":612,"message":"password incorrecto"}.)

2. SIGN-IN (code → token OpenID de Cognito)
   POST https://x78kr8nqx5.execute-api.us-east-1.amazonaws.com/prod/sign-in
   { "rut":"", "opts":{ "code":"<uuid>", "state":"<state>", "authMethod":"clave-tributaria" } }
   → { "openId": { "IdentityId":"us-east-1:...", "Token":"<JWT>" } }
   Este endpoint se llama SIN credenciales AWS (Amplify lo firma con Credential=undefined):
   es efectivamente público. El Lambda detrás valida el code contra el SII y hace
   GetOpenIdTokenForDeveloperIdentity del lado servidor.

3. CREDENCIALES AWS TEMPORALES (token → AccessKey/Secret/SessionToken)
   POST https://cognito-identity.us-east-1.amazonaws.com/
   X-Amz-Target: AWSCognitoIdentityService.GetCredentialsForIdentity
   { "IdentityId":"us-east-1:...", "Logins":{ "cognito-identity.amazonaws.com":"<JWT del paso 2>" } }
   → { "Credentials":{ "AccessKeyId":"ASIA...", "SecretKey":"...",
                       "SessionToken":"...", "Expiration":<epoch> } }

4. LLAMADAS A LA API — firmadas con SigV4 usando esas credenciales temporales,
   contra los endpoints de API Gateway y contra Lambda directo
   (`lambda.us-east-1.amazonaws.com/.../functions/<fn>/invocations`).
```

Es el patrón **Cognito Developer Authenticated Identities**. El JWT del paso 2
trae en sus claims `amr: ["authenticated","sii.login","sii.login:<pool>:<rut-dv>"]`,
`iss: https://cognito-identity.amazonaws.com`, y expira ~12 h (`exp - iat`). Las
credenciales del paso 3 son temporales de STS (empiezan en `ASIA`), con su propia
expiración más corta: hay que renovarlas repitiendo el paso 3 con el mismo token,
y rehacer 1-2 cuando el token expira.

Hay **dos identity pools** en juego: `e154b392-…` (el del bundle; un intento de
`GetId` sin autenticar contra él devuelve *"Unauthenticated access is not
supported"*) y `337509f2-…` (el `aud` del token, el que efectivamente entrega las
credenciales). El que importa es el segundo.

### Qué significa para el gateway

- **No hace falta navegador en runtime.** Cuatro POST con `curl`/SDK y quedás con
  credenciales AWS temporales. Mucho más simple que los seis pasos de HTML +
  firma con certificado de las facturas.
- **La credencial del cliente es RUT + clave tributaria**, no certificado. Distinto
  del portal CGI (que va por certificado). Para el gateway multi-tenant, el
  secreto por RUT acá es la clave tributaria.
- **El SII firma del lado servidor**: no aparece ningún plugin de firma. Confirmar
  al emitir, pero el indicio es fuerte.

## Config del emisor (relevada de los Lambda)

Tras autenticar, la SPA llama Lambdas de configuración. Útil para el gateway:

- `eboleta-configuracionesEmision-prod` → reglas de emisión: sobre cierto monto
  (`MONTO_MAYOR_QUE`) la boleta `REQUIERE_MEDIO_PAGO`, y en efectivo además
  `REQUIERE_RECEPTOR` y `REQUIERE_DETALLE`. O sea: **la boleta chica no exige
  receptor** —el caso de Parkingapp—.
- `eboleta_getConfigPorContribuyente` → `{ contribuyente:<rut empresa>,
  username:"<rut-dv persona>", env:"prod" }` → topico de notificaciones (IoT MQTT
  sobre WebSocket). El `contribuyente` (empresa) y el `username` (persona) van
  separados, igual que en el portal CGI.

## Lo que falta

1. ~~El intercambio OAuth → Cognito.~~ **Resuelto (arriba).**
2. **Confirmar el campo exacto que trae el `code`** en la respuesta del paso 1: el
   HAR registró el `authorize` exitoso con body vacío (limitación de captura del
   XHR), pero el `code` llega a `eboleta.sii.cl/emitir/?code=…`, así que la
   respuesta del `authorize` lo trae. Detalle de build, no de arquitectura.
3. **El captcha.** El login mandó `token_captcha:"0"`, o sea que en este flujo el
   captcha estaba deshabilitado/omitido. Verificar si siempre es así o si bajo
   ciertas condiciones el SII exige resolver un captcha —eso sí complicaría el
   runtime headless—.
4. ~~**El contrato de `POST /api/dte/documentos/generar`**.~~ **Relevado el
   2026-08-13 emitiendo una boleta real (folio 2, $50, TRUFUL). Ver sección
   abajo.**
5. ~~**Renovación**: medir la vigencia.~~ **Medido el 2026-08-13:** las
   credenciales STS del paso 3 caducan en **~1 h**; el token OpenID del paso 2
   dura **~12 h** (`exp - iat`). Refresh del gateway: re-correr el paso 3 con el
   mismo token mientras viva (~12 h), y recién entonces rehacer login (1-2).

## El cliente de auth funciona en vivo

El cliente (`src/boletas/auth.ts`, `BoletaAuth`) se verificó de punta a punta
contra el SII real el 2026-08-13: `autenticar(user, clave)` devolvió credenciales
STS válidas (`AccessKeyId` ASIA…, `SessionToken`, `Expiration` ~1 h). Los tres
pasos del contrato quedan confirmados por ejecución, no sólo por captura.

## Emisión: contrato de `documentos/generar` (relevado emitiendo)

Se emitió una boleta afecta real (TipoDTE 39, $50, TRUFUL) el 2026-08-13 y se
capturó el request. Es **un solo POST firmado SigV4, sin previsualización y sin
firma con certificado** (el SII firma del lado servidor). Mucho más simple que
los seis pasos de las facturas.

```
POST https://cn68i6qm0g.execute-api.us-east-1.amazonaws.com/prod/api/dte/documentos/generar
  SigV4 service=execute-api, SignedHeaders: host;x-amz-date;x-amz-security-token
  Content-Type: application/x-www-form-urlencoded  (el body igual es JSON;
    el content-type NO se firma, así que la incongruencia no afecta la firma)

  body (JSON):
  {
    "vendedor": "22222222-2",              // RUT-DV de la persona logueada
    "Encabezado": {
      "IdDoc":   { "TipoDTE": 39, "Folio": 1, "MedioPago": 1 },
      "Emisor":  { "RUTEmisor": "11111111-1", "CdgSIISucur": 92059768 },
      "Receptor":{ "RUTRecep": "66666666-6", "RznSocRecep": "SII Boleta", "DirRecep": "Santiago" }
    },
    "Detalle": [ { "NmbItem": "Monto Total", "QtyItem": 1, "PrcItem": 50 } ],
    "Meta": {
      "info_emisor": { ...razonSocial, giro, numeroResolucion, fechaResolucion,
                       tiposDte, sucursales, esRepresentanteLegal... },
      "geolocalizacion": { "latitude": -33.42, "longitude": -70.56 },
      "plataforma": "eboleta_web"
    }
  }

  respuesta (JSON): { "folio": 2, "dte": {...}, "pdf_public_url": "...", "b64encoded_pdf": "data:application/pdf;base64,..." }
```

Puntos que importan:

- **El folio real vuelve en `respuesta.folio`**, limpio. Nada del falso positivo
  del "folio propuesto" del portal CGI: acá el servidor asigna y devuelve. El
  request manda `Folio: 1` como placeholder y el servidor lo ignora (la boleta
  salió con folio 2).
- **`Receptor` con el RUT genérico `66666666-6` "SII Boleta"** es la boleta sin
  receptor identificado —el caso de Parkingapp—. Con receptor real iría el RUT
  del cliente. `MedioPago: 1` (efectivo).
- **La respuesta trae el PDF** (URL S3 firmada + base64 inline), útil para
  entregar comprobante.

Preguntas abiertas para construir el cliente de emisión:

- ~~**De dónde sale `Meta.info_emisor`.**~~ **Resuelto leyendo el bundle:** en el
  código de emisión `f.meta = {info_emisor: t.datosEmisor}`, o sea que
  `info_emisor` es **el passthrough del endpoint** `GET
  /api/info-contribuyente/info-emisor-usuario/{a}/{b}` (`datosEmisor` en el
  store). No se arma a mano: se pide y se reenvía. **Confirmado en vivo el
  2026-08-13** (host `cn68i6qm0g`, GET firmado SigV4):
  - `emisores-usuario/{rut-dv}` → empresas del usuario `[{rut, dv, razon_social}]`
    (exige el DV; sin DV devuelve `[]`).
  - `info-emisor-usuario/{rutEmpresaSinDv}/{rutUsuarioConDv}` → el blob que va como
    `info_emisor`. El orden importa: empresa sin DV, después usuario con DV; las
    otras combinaciones devuelven "No hay datos registrados para el contribuyente".
- ~~**`geolocalizacion`**: probar si acepta `0,0`.~~ **Confirmado el 2026-08-13:
  el servidor acepta `0,0`.** El cliente `emitir` de `BoletaApi` emitió una
  boleta real de punta a punta (folio 3) con `geolocalizacion: {latitude: 0,
  longitude: 0}`. El gateway queda verificado en vivo: auth → info_emisor → firma
  SigV4 → emisión con PDF.

## Recomendación

Proyecto separado del scraper de mipyme, con transporte propio (SigV4 vía SDK de
AWS o firma manual). Del login sólo se reusa el concepto; el mecanismo es otro
(clave tributaria + OAuth, no certificado). El **núcleo multi-tenant de este repo
(cola por RUT, registro por credencial, proveedor de credenciales) sí se reusa
tal cual**: la clave tributaria por RUT encaja en `ProveedorCredenciales` igual
que la config del CGI.

Ya se puede empezar a escribir el cliente de auth: los cuatro pasos están
relevados. Emitir queda detrás de relevar el punto 4.
