# mcp-sii

Servidor MCP open source para el Sistema de Facturación Gratuito del SII (mipyme.sii.cl).
Permite a agentes IA (Claude, etc.) consultar documentos tributarios emitidos y recibidos.

## Requisitos

- Node.js 24+
- agent-browser instalado globalmente: `npm install -g agent-browser && agent-browser install`
- Certificado digital del SII instalado en el keychain del sistema (para operaciones marcadas con *)

## Instalación

```bash
npm install
npm run build
```

## Autenticación: sesión por RUT

Ya no hay una única credencial fija por proceso. Antes de llamar cualquier
tool de consulta hay que abrir sesión para el RUT que se va a usar:

1. `sii_iniciar_sesion(rut, clave)` — autentica al SII con el RUT y la clave
   tributaria de esa persona. La credencial vive sólo en memoria del proceso
   (no se persiste a disco) y queda asociada a ese `rut`. Repetir la llamada
   con el mismo RUT no abre una sesión nueva mientras la anterior siga
   vigente (dentro de 2 horas) — abrir sesiones de más agota el límite del
   SII para ese RUT.
2. Cualquier otra tool (`sii_bhe_resumen`, `sii_dte_list_documentos_emitidos`,
   `sii_rcv_resumen`, etc.) recibe `rut` como su **primer parámetro
   obligatorio** y opera sobre la sesión que abrió el paso anterior. Si no
   hay sesión iniciada para ese RUT, la tool devuelve
   `{ "ok": false, "error": "SESION_NO_INICIADA" }` en vez de autenticar
   sola — no hay auto-login implícito.
3. `sii_cerrar_sesion(rut)` — cierra la sesión en el SII **y olvida la
   credencial** de ese RUT. Conviene llamarla siempre al terminar: el SII
   limita cuántas sesiones simultáneas puede tener un RUT y las bloquea al
   superarlas (error `01.01.190.500.720.27`).

Esto permite operar varios RUT en paralelo desde el mismo proceso, cada uno
con su propia credencial y su propia sesión (cookie jar independiente).

**Limitación actual:** `sii_iniciar_sesion` sólo acepta `rut` + `clave`
(autenticación por clave tributaria, que corre por navegador). No hay hoy
forma de autenticar con certificado digital por esta vía. Las tools que
consultan por HTTP en vez de navegador (`sii_bhe_*`, `sii_rcv_*`,
`sii_dte_*`, `sii_renta_*`, `sii_mipyme_list_*`) necesitan el archivo de
cookies que **sólo produce** la autenticación con certificado — una sesión
abierta con clave vía `sii_iniciar_sesion` no lo genera, y esas tools van a
fallar (`RequiereCertificado`) para un RUT autenticado así. Hoy funcionan sin
problema con `sii_iniciar_sesion` las tools que operan por navegador:
`sii_persona_list_bienes_raices` y `sii_mipyme_emitir_dte`.

## Configuración

Variables de entorno (crear `.env` o configurar en Claude Desktop):

```bash
# RUT de la persona natural autorizada (no el RUT de la empresa). Requerida
# para que el proceso arranque, aunque ya no se usa para autenticar tools:
# la autenticación de tools pasa por sii_iniciar_sesion(rut, clave).
SII_RUT=12345678

# RUT de la empresa a operar (requerido si la persona opera múltiples empresas).
# Se sigue usando como fallback cuando la tool no recibe empresaRut.
SII_EMPRESA_RUT=22222222

# Sólo para EMITIR DTE en el portal mipyme: la clave del certificado digital que
# el contribuyente tiene cargado EN EL SII (el "certificado centralizado"), con
# la que el SII firma el documento del lado servidor.
SII_CERT_CLAVE_SII=claveDelCertCargadoEnElSii
```

`SII_CERT_CLAVE_SII` **no** se deriva de `SII_CERT_PASSWORD`, aunque parezca lo
mismo. El certificado cargado en el SII puede ser otro archivo, o el mismo
cargado con otra clave — y en ese segundo caso comparar los certificados diría
"coinciden" mientras la clave sigue sin servir. Si en tu caso son la misma
clave, configurá las dos variables con el mismo valor: queda explícito y no
depende de una suposición del código.

Sin esta variable, emitir falla pidiéndola; todo lo demás (consultas y la
previsualización de un DTE) funciona igual.

### Perfiles de verificación contra el SII real

Verificar el servicio entero necesita **cuatro** credenciales, no una: lo que un
contribuyente puede consultar depende de qué es y de cómo factura, y el
certificado es además otra forma de entrar.

| Perfil | Qué es | Verifica |
|---|---|---|
| `SII_PERSONA_*` | Persona natural | BHE emitidas y recibidas, bienes raíces, renta |
| `SII_MIPYME_*` | Inscrito en Facturación Gratuita del SII | El portal mipyme entero |
| `SII_MERCADO_*` | Factura con software de mercado | RCV, DTE, F29 |
| `SII_CERT_*` | Certificado digital (`.pfx` en disco) | Lo mismo que su titular, **más firmar**: `emitir-dte` |

El de certificado no es otro contribuyente sino la otra forma de autenticar, y
es la **única con la que se puede firmar**. El `.env` guarda la *ruta* del `.pfx`
—es un binario de varios KB— y la conversión a base64 que piden las rutas la hace
`perfilesVerificacion.ts`.

El de mipyme no es intercambiable: **si el RUT no está inscrito en Facturación
Gratuita, el selector de empresas del portal viene sin una sola opción** y no hay
nada que consultar. Eso no se ve en el `.env` ni en ningún otro lado hasta que se
intenta, y por eso existe:

```bash
npx ts-node src/scripts/clasificarCredencial.ts          # los que estén cargados
npx ts-node src/scripts/clasificarCredencial.ts mipyme   # uno en particular
```

Sondea las rutas REST de producción y dice para qué sirve realmente cada
credencial. Conviene correrlo **antes** de empezar una ronda, no a la mitad.

`perfilesVerificacion.ts` **no sustituye un perfil por otro**: si falta el que se
pide, falla diciendo cuál. Un fallback haría correr la verificación contra un
contribuyente distinto, y ahí ni el verde ni el rojo dicen nada sobre lo que se
quería probar.

Ver `.env.example` para la plantilla completa.

### Legado: `SII_CLAVE` / `SII_CERT_PATH` (una sola credencial por proceso)

```bash
SII_CLAVE=mipassword
# o, con precedencia sobre la clave:
SII_CERT_PATH=/ruta/al/certificado.pfx
SII_CERT_PASSWORD=passwordDelCert
```

Estas variables ya **no** son la forma de autenticar las tools: el código
que las lee (`getConfig()`/`validateEnv()`) sigue existiendo, pero ninguna
tool de consulta pasa por ahí — todas usan la credencial que dejó
`sii_iniciar_sesion` para el `rut` de la llamada. Quedan documentadas acá
sólo porque `npm run validate-cert` (más abajo) las sigue leyendo para
validar el `.pfx` fuera del flujo de sesión.

## Validar certificado digital

Antes de usar `SII_CERT_PATH`/`SII_CERT_PASSWORD`, puedes verificar que el `.pfx`
existe y que la contraseña lo desbloquea correctamente (sin exponer el subject/issuer,
que suele contener datos personales):

```bash
npm run validate-cert
```

Lee `SII_CERT_PATH` y `SII_CERT_PASSWORD` desde el entorno (`.env`) y termina con
código 0 si el certificado es válido, o 1 con un mensaje de error si no.

## Uso con Claude Desktop

Agregar en `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sii": {
      "command": "node",
      "args": ["/ruta/a/mcp-sii/dist/src/index.js"],
      "env": {
        "SII_RUT": "12345678",
        "SII_EMPRESA_RUT": "22222222"
      }
    }
  }
}
```

`SII_RUT` sigue siendo requerida para que el proceso arranque, pero ya no
autentica nada por sí sola. Una vez conectado, autenticá cada RUT con el que
vayas a operar llamando `sii_iniciar_sesion(rut, clave)` desde el chat antes
de pedir cualquier consulta.

## Tools disponibles

Todas las consultas son de **solo lectura**, con una única excepción marcada como tal.
Todas reciben `rut` como primer parámetro — ver
[Autenticación: sesión por RUT](#autenticación-sesión-por-rut).

### Sesión

| Tool | Descripción |
|---|---|
| `sii_iniciar_sesion` | Autentica un RUT con su clave tributaria. Necesaria antes de llamar cualquier otra tool con ese RUT |
| `sii_cerrar_sesion` | Cierra la sesión en el SII para ese RUT y olvida su credencial (conviene al terminar) |

### Portal mipyme — Sistema de Facturación Gratuito

| Tool | Descripción |
|---|---|
| `sii_mipyme_list_empresas` | Empresas que la persona puede operar **en este portal** |
| `sii_mipyme_list_dte_emitidos` | Historial de DTE emitidos por este portal, de a 100 por página |
| `sii_mipyme_list_dte_recibidos` | DTE recibidos por la empresa, con el estado del acuse |
| `sii_mipyme_list_borradores` | Borradores guardados, con todos los campos del SII |
| `sii_mipyme_emitir_dte` | **Emite** un DTE. Acto tributario real e irreversible — ver la advertencia abajo |

### Consultas DTE

| Tool | Descripción |
|---|---|
| `sii_dte_list_documentos_emitidos` | Resumen por tipo de documento del período, con detalle opcional |
| `sii_dte_list_documentos_recibidos` | Ídem, del lado recibido |
| `sii_dte_get_documento_emitido` | Detalle de un documento emitido |
| `sii_dte_get_documento_recibido` | Detalle de un documento recibido |

### Impuestos y registros

| Tool | Descripción |
|---|---|
| `sii_rcv_resumen` | Registro de Compras y Ventas, resumen del período |
| `sii_rcv_detalle` | Registro de Compras y Ventas, documento por documento |
| `sii_rcv_tipos_documento` | Catálogo de los 46 tipos de documento del registro |
| `sii_rcv_empresas_autorizadas` | Empresas que el RUT puede **consultar** en el RCV |
| `sii_renta_get_f22` | Formulario 22 completo de un año tributario |
| `sii_renta_estado_declaracion` | Estado de la declaración de renta |

`sii_rcv_detalle` devuelve **26 campos por documento**, no sólo los montos
básicos: además de neto, exento, IVA y total, informa el IVA no recuperable con
su código, el neto e IVA de activo fijo, el IVA de uso común, el impuesto sin
derecho a crédito, el IVA no retenido, los tres montos de tabaco, las fechas de
recepción y de acuse, y el tipo de transacción. Para cuadrar un F29 no son
opcionales: el IVA no recuperable, el de uso común y el de activo fijo cambian el
crédito fiscal. `sii_rcv_resumen` informa los dos primeros por tipo de documento
y en los totales.

Dos criterios al leer esos campos. **Los montos vienen en `0` y los códigos en
`null`**: el SII manda 0 cuando el concepto no aplica al documento, y ahí el cero
ES el dato, mientras un código en 0 no sería "código cero" sino "no hay". Y
**`fechaRecepcion` trae hora y `fechaEmision` no** (`23/06/2026 12:51:37` contra
`23/06/2026`): son dos formatos distintos en la misma fila, tal como los manda el
SII, y no se normalizan para que la diferencia se vea en vez de descubrirse
parseando.

`sii_mipyme_list_borradores` sale de **otra aplicación del SII**, no del portal
clásico: `mipymeinternetui`, con su propia API. Devuelve los campos con los
nombres del SII (`EFXP_*`) sin renombrar, porque un borrador trae decenas que
dependen del tipo de documento y elegir cuáles exponer sería adivinar qué
necesita quien consulta. Verificado con un borrador real: `ehdr_CODIGO` es el
código y `ptdc_CODIGO` el tipo de documento.

**Los borradores cuelgan de la empresa activa**, así que `empresa_rut` importa:
sin él, un RUT que opera varias empresas recibe los borradores de la que dejó la
consulta anterior. No es teórico — con la empresa sin fijar, las cinco empresas
de prueba devolvían cero borradores, y un listado vacío se lee como "no tenés
borradores" en vez de "preguntaste por otra empresa".

Tres cosas del catálogo de apigateway **no se homologaron, y no por falta de
tiempo**:

- **`dte-xml`.** El único camino del portal a un XML es la descarga masiva
  (`mipeDownLoad.cgi`), que baja el lote entero según los filtros de la pantalla
  y está detrás de un reCAPTCHA. No hay descarga individual, y un reCAPTCHA no es
  un camino que un servicio pueda recorrer solo.
- **`borrador-pdf`.** Depende de tener un borrador; sin ninguno no hay nada que
  relevar ni con qué verificar.
- **`info-contribuyente`.** El formulario de emisión no expone ningún CGI de
  consulta de contribuyente: los datos del receptor aparecen recién al
  previsualizar, o sea que no hay una consulta separada que homologar.

El **PDF de un documento** existe sólo como ruta REST (`POST /v1/mipyme/dte-pdf`),
no como tool MCP, igual que el de BHE: un PDF en base64 dentro de una respuesta
MCP satura el contexto sin que el modelo pueda hacer nada con él. Se pide por el
`codigo` que devuelve el listado y **no por el folio**, que se repite entre
emisores y entre tipos de documento.

`sii_mipyme_list_dte_recibidos` es el espejo de `list_dte_emitidos` y comparte su
forma, con el **emisor** como contraparte en vez del receptor. Trae algo que
`sii_rcv_*` no tiene: el **estado del acuse** (`DTE Recibido Sin Reparos`,
`con Reparos`), que es la respuesta que la empresa dio al documento.

`sii_rcv_empresas_autorizadas` **no** es lo mismo que `sii_mipyme_list_empresas`:
éstas son las empresas que el RUT puede **consultar** en el registro, y las de
mipyme las que puede **operar** en el portal de facturación gratuita. Un RUT
puede estar en una lista y no en la otra. Confundirlas llevaría a ofrecer
facturar por una empresa que sólo se puede mirar.

### Indicadores y valores publicados

| Tool | Descripción |
|---|---|
| `sii_indicadores_uf` | Valor diario de la UF de un año |
| `sii_indicadores_dolar` | Dólar observado diario de un año |
| `sii_indicadores_utm` | UTM, UTA e IPC por mes |
| `sii_indicadores_correccion_monetaria` | Factores de corrección monetaria por mes |
| `sii_indicadores_impuesto_2da_categoria` | Tramos del impuesto único de 2ª categoría (art. 43) |
| `sii_indicadores_impuesto_2da_categoria_art52` | Tramos del art. 52 bis |

### Tasación de vehículos

| Tool | Descripción |
|---|---|
| `sii_vehiculos_tipos` | Tipos de vehículo de la planilla de un año |
| `sii_vehiculos_marcas` | Marcas, opcionalmente por tipo |
| `sii_vehiculos_modelos` | Modelos de una marca con versiones y años tasados |
| `sii_vehiculos_tasacion` | Tasación fiscal y permiso, por código SII o marca+modelo |

Sin `rut` ni credencial, como indicadores. La fuente **no** es la consulta
interactiva del portal —exige un captcha propio del SII antes de cualquier
búsqueda— sino las **planillas XLSX anuales** que el SII publica (`liv{año}` para
livianos, `pes{año}` para pesados, desde 2020). La primera consulta de un año baja
la planilla entera (~7 MB, unos segundos) y las siguientes salen de memoria.
Livianos y pesados traen columnas distintas: pesados tiene carga y pasajeros y
**no trae permiso** (va en `null`); livianos al revés. El diccionario de siglas de
equipamiento está en `/v1/vehiculos/equipamiento`.

Ni estas tools ni las de vehículos reciben `rut` ni credencial, ni necesitan
`sii_iniciar_sesion`: el SII publica estas tablas abiertas. En REST viven bajo
`/v1/indicadores/…` y `/v1/vehiculos/…`, y siguen pasando por el auth de tenant y
el rate-limit, como todas.

Tres cosas al leerlas:

- **Un día que el SII no publicó no aparece**, en vez de aparecer en cero. El
  dólar sólo trae días hábiles, y el año en curso llega hasta el último día
  publicado. Un cero en un tipo de cambio no es lo mismo que "no hay dato".
- **La corrección monetaria es triangular**: un mes no tiene factor contra los
  meses anteriores, así que muchas celdas vienen en `null`, y ese `null`
  significa "no corresponde".
- **En los tramos de 2ª categoría, el tramo exento trae `exento: true` y sus
  números en `null`**, no en 0. Un factor 0 daría el mismo impuesto por un camino
  que la tabla no dice. El art. 43 trae los cuatro períodos (MENSUAL, QUINCENAL,
  SEMANAL, DIARIO) y el art. 52 bis sólo el mensual; el último tramo de cada
  período no tiene tope, y ahí `hasta` va en `null`.

Los resultados se cachean en memoria por año e indicador. Un año ya cerrado no se
vuelve a consultar nunca —el valor de la UF de un día pasado no cambia— y el año
en curso se revisa cada seis horas. Cada consulta baja una página entera del SII,
y el SII corta por volumen: sin caché, convertir cien montos a UF bajaría cien
veces la misma tabla.

### Boletas de honorarios y persona natural

| Tool | Descripción |
|---|---|
| `sii_bhe_list_emitidas` | Boletas de honorarios emitidas |
| `sii_bhe_list_recibidas` | Boletas de honorarios recibidas |
| `sii_bhe_resumen` | Resumen anual de boletas emitidas |
| `sii_bhe_resumen_recibidas` | Resumen anual de boletas recibidas |
| `sii_persona_list_bienes_raices` | Bienes raíces de la persona, con los códigos del catastro |
| `sii_bienes_raices_comunas` | Comunas del catastro con su código |
| `sii_bienes_raices_consultar_rol` | Un bien raíz **cualquiera** por rol: avalúo y contribuciones |
| `sii_bienes_raices_multipropietarios` | Copropietarios de un rol |
| `sii_bienes_raices_solicitudes` | Historial de certificados pedidos, con la url del PDF |

Los dos resúmenes anuales devuelven **siempre los doce meses**, en orden: un mes
sin actividad viene en cero y con los folios en `null`. Devolver sólo los meses
con boletas obligaba a interpretar una ausencia, y "no tuvo" se veía igual que
"no se pudo leer".

`sii_bhe_resumen_recibidas` **no** equivale a sumar `sii_bhe_list_recibidas`:
son dos CGI distintos del SII, y el anual informa una retención del
contribuyente que el informe mensual de recibidas no muestra. Para 07/2026 el
anual da 19.063 de retención y el mensual muestra "Retenido 0" en las cuatro
boletas — en la UI del portal y en la API por igual. Si necesitás la retención
de las boletas recibidas, sale de ahí y de ningún otro lado.

En ese informe, además, `folioInicial` y `folioFinal` vienen **siempre en
`null`**, por mes y del año. El portal no muestra folios ahí, y un rango no
significaría nada: cada boleta la folió un emisor distinto.

`sii_bhe_list_recibidas` pagina los meses de **más de 100 boletas** encadenando el
código de continuación del informe; no hay captura real de un mes así y la
garantía son los chequeos de integridad (conteo y duplicados). El detalle está en
la guía de integración, sección de limitaciones.

Bienes raíces ya **no usa navegador**: la SPA del portal tiene detrás una API
REST/JSON (`/app/vica/{rut}/v1/…`) y el servicio le pide lo mismo que la SPA.
Sin esa cookie del contexto `/app` que deja el handshake de la SPA, la API
responde **cero bytes**, no un error. Los certificados de avalúo
(`/v1/bienes-raices/certificado-avaluo`) y el PDF de una solicitud
(`/v1/bienes-raices/documento`) van sólo por REST: un PDF en base64 satura el
contexto del modelo. Pedir un certificado es una **solicitud real** que queda en
el historial del contribuyente; no es un acto tributario ni tiene costo, pero
tampoco es una lectura, y por eso no se cachea ni se reintenta solo.

`sii_persona_list_bienes_raices` funciona con la sesión que abre
`sii_iniciar_sesion` (clave, por navegador). El resto de las consultas por HTTP
—Consultas DTE, Impuestos y registros, boletas de honorarios y los listados de
mipyme— aceptan **clave tributaria o certificado digital**: las dos producen el
cookie jar que esa vía necesita. La única que sigue exigiendo certificado es
`sii_mipyme_emitir_dte` cuando firma, porque firmar un DTE necesita el
certificado de verdad y no basta una sesión autenticada.

### Situación tributaria de terceros

`POST /v1/contribuyente/situacion-tributaria` con `{ rut }`. Es la única ruta del
adaptador que **no lleva credencial del contribuyente**: el SII publica esta
consulta abierta, así que se puede preguntar por cualquier RUT. Sigue pasando por
el auth de tenant y el rate-limit del servidor, como todas.

Devuelve razón social, si presenta inicio de actividades y desde cuándo, si es
empresa de menor tamaño (pro-pyme), si declara en moneda extranjera, y las
actividades económicas vigentes con su código, giro, categoría y si afectan IVA.

Tres cosas que conviene saber:

- **El dígito verificador se valida** antes de consultar. El SII resuelve por el
  cuerpo del RUT, así que un DV mal escrito devolvería los datos del
  contribuyente con el DV corregido — o sea que un RUT inválido saldría como
  válido. Con DV incorrecto la respuesta es `400`, y el `detalle` dice cuál era
  el que correspondía.
- **Hay caché en memoria de 24 horas por RUT.** Esta consulta le pega dos veces a
  `zeus.sii.cl` (captcha más informe) y el dato casi no cambia. Sólo se cachean
  los éxitos: un fallo del portal, o un RUT que todavía no tiene datos, se
  vuelven a consultar.
- **`observaciones` y `documentos_timbrados` no se emiten todavía**: no hay una
  captura del informe que los traiga, y escribir el parseo a ciegas devolvería
  datos plausibles que nadie revisaría. Está anotado en la spec del endpoint.

### Cambios recientes que rompen contrato

La migración del portal mipyme a HTTP directo (2026-08-03) cambió dos cosas para
quien ya usaba estas tools:

- **`sii_mipyme_list_empresas` y `sii_mipyme_list_dte_emitidos` ahora requieren
  certificado digital.** Antes corrían por navegador y aceptaban clave tributaria.
  El camino HTTP necesita el archivo de cookies que sólo produce la autenticación
  con certificado, igual que el resto de las consultas. Fallan de entrada, con el
  mensaje que dice qué configurar. `sii_mipyme_emitir_dte` sigue por navegador y
  sigue aceptando clave.
- **`limit` ya no existe en `sii_mipyme_list_dte_emitidos`: se reemplaza por
  `pagina`.** El CGI entrega de a 100 documentos por página y recortar del lado
  del cliente escondía que había más. La respuesta ahora informa `pagina` y
  `totalPaginas`.

La resolución de la empresa no cambió: el parámetro gana, si no vino se usa
`SII_EMPRESA_RUT`, y si tampoco hay se resuelve sola cuando el RUT opera una única
empresa en el portal.

### Advertencias

- **`sii_mipyme_emitir_dte` está probablemente inoperativa.** Apunta a `mipeDocAlta.cgi`,
  que responde 404 (medido el 2026-08-03). La ruta del portal es
  `mipeLaunchPage.cgi?OPCION=<tipo>&TIPO=4`, pero no se corrigió sin relevar antes el
  formulario que sirve: apuntarla a ciegas convertiría un fallo visible en un camino que
  emite documentos tributarios reales con parámetros adivinados.
- **`sii_dte_*` y `sii_rcv_*` no son comparables.** Responden preguntas distintas y sus
  cifras no cuadran: Consultas DTE incluye guías de despacho, clasifica las facturas de
  compra del lado emitido, y sus recibidos difieren de los del RCV. Ninguno está mal.
- **Cada aplicación del SII tiene su propia lista de empresas autorizadas.** La de
  `sii_mipyme_list_empresas` no coincide con la que habilitan el RCV o Consultas DTE.

## Adaptador REST: contrato de errores

Las rutas `/v1/*` responden siempre HTTP 200 —salvo `400` por body inválido— y el
resultado va en el cuerpo: `{"ok": true, ...}` o `{"ok": false, "error": "..."}`.

Lo que un consumidor necesita saber de cada código es **si reintentar sirve**:

| `error` | ¿Reintentar? | Cuándo aparece |
|---|---|---|
| `BAD_REQUEST` (HTTP 400) | No | El body no valida. Trae `detalle` con el campo y el motivo |
| `CREDENCIALES_INVALIDAS` | No | El portal dijo explícitamente que la clave es incorrecta |
| `NO_ENCONTRADO` | No | El SII confirmó que el dato no existe. Trae `detalle` |
| `LIMITE_CONOCIDO` | No | Un límite que ya conocemos: un descuadre entre lo que el SII informa y lo que se recupera, o un cambio de formato de un CGI. Trae `detalle` |
| `SESIONES_SIMULTANEAS` | **Sí**, tras esperar | El RUT ya tiene demasiadas sesiones abiertas en el SII. Trae `detalle` |
| `LIMITE_SII` | **Sí, esperando de verdad** | El SII cortó las consultas por volumen (su propio error 429). Trae `detalle` |
| `ERROR` | **Sí** | Todo lo demás: cola de espera del SII, portal caído, fallo de red |

`LIMITE_SII` es el que más cambia qué hacer: el SII tiene rate limiting propio y,
con muchas consultas al mismo portal en poco tiempo, corta ESE PORTAL ENTERO por
un rato — para todos. Reintentar de inmediato es lo que mantiene el corte: hay
que esperar minutos, no segundos, y bajar el ritmo. Los barridos internos ya van
con pausa por esto mismo (`src/ritmoSii.ts`).

Un detalle que cuesta diagnosticar: el SII **no** devuelve un status 429, devuelve
una página HTML. Sin mirar el cuerpo es indistinguible del HTML del login —o sea
de "la sesión expiró"— y las dos cosas piden lo contrario: una que esperes, la
otra que reintentes reautenticando.

`SESIONES_SIMULTANEAS` se comporta igual que `ERROR` —reintentar sirve— y
existe por lo que permite **decirle a la persona**. Con `ERROR` sólo cabe "probá
de nuevo en unos minutos"; con éste se le puede decir que hay otra consulta en
curso sobre el mismo contribuyente, que es accionable: sabe que dejó otra
pestaña abierta o que un colega está mirando el mismo caso. Salía mezclado en
`ERROR` y eso mandaba a diagnosticar timeouts y problemas de red que no existían.

Los dos códigos con "no" que podrían confundirse:

- `CREDENCIALES_INVALIDAS` se reserva para cuando el portal lo dice con esas
  palabras. Un fallo transitorio sale como `ERROR`, nunca como credencial
  inválida — si no, un consumidor que borra la credencial al recibirlo estaría
  borrando claves que sí servían por una caída del SII.
- `LIMITE_CONOCIDO` existe porque esos casos son permanentes y salían como
  `ERROR`: el consumidor reintentaba en loop algo que nunca iba a funcionar.

## Desarrollo

```bash
npm test          # correr tests
npm run dev       # desarrollo con ts-node
npm run build     # compilar TypeScript
```

### Pruebas contra el SII real

`npm test` usa el navegador mockeado y no toca la red. Existe además una suite
que le pregunta al portal de verdad, con su propio comando:

```bash
npm run test:e2e
```

Necesita `SII_RUT` y `SII_CLAVE` en el `.env`; sin credenciales se saltea sola en
vez de fallar. Cubre dos cosas: que la clave correcta autentique y deje cookies
de sesión utilizables, y que un login que no puede tener éxito **no** se reporte
como exitoso. Ese segundo caso existe porque fue un bug real en producción
(`validar-clave` respondía `ok:true` con cualquier clave) y ningún test con el
navegador mockeado podía detectarlo: el criterio de éxito estaba mal, y el mock
contestaba lo que le habíamos enseñado a contestar.

Va separada de `npm test` a propósito. Cada test abre una sesión real, y el SII
limita las sesiones simultáneas por RUT y **bloquea las claves con varios
intentos fallidos**, así que no conviene que se dispare desde CI ni sin querer.

Hay un tercer caso, apagado por defecto, que manda una clave incorrecta al RUT
propio para verificar que se clasifica como `CREDENCIALES_INVALIDAS`:

```bash
SII_E2E_CLAVE_MALA=1 npm run test:e2e
```

Es el único que ejercita esa clasificación de punta a punta, y también el único
que acumula intentos fallidos sobre una cuenta real. Correlo puntualmente, no en
loop.
