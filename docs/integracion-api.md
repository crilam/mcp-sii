# mcp-sii — Guía de integración de la API REST

Referencia del adaptador REST multi-tenant que consulta el SII de Chile.

**Base URL de producción:** `https://mcp-sii.redcomercio.cl`

Todo lo de este documento sale del código. Donde algo no está garantizado, lo dice explícitamente en vez de prometerlo.

---

## 1. Cómo funciona, en una frase

El SII no tiene API. Este servicio automatiza el portal `sii.cl` con las credenciales del contribuyente y devuelve los datos como JSON. De ahí salen casi todas las rarezas del contrato: los datos vienen de informes pensados para que los lea una persona, y a veces el portal informa distinto el mismo hecho en dos informes distintos.

Dos consecuencias que conviene tener presentes desde el principio:

- **Cada llamada abre una sesión real en el SII.** El SII limita las sesiones simultáneas por RUT, así que no conviene paralelizar muchas llamadas del mismo RUT.
- **Las llamadas son lentas** comparadas con una API normal: hay que autenticarse y navegar. El servidor corta a los 35 segundos.

---

## 2. Autenticación

Dos capas independientes que se confunden fácil:

| Capa | Qué autentica | Cómo viaja |
|---|---|---|
| **Tenant** | Tu aplicación contra este servicio | Header `Authorization: Bearer <api_key>` |
| **Contribuyente** | El RUT contra el SII | Campos del body (`rut` + `clave`, o certificado) |

### 2.1 API key del tenant

```
Authorization: Bearer sk_<tenant>_<random>
```

El header tiene que empezar con el literal `Bearer ` (con espacio). Cualquier otra cosa da `401`.

El prefijo lleva el nombre del tenant para poder identificar la key de un vistazo. **Precisamente por eso el header completo nunca debe llegar a un log**: el prefijo ya identifica de qué consumidor es. En el servidor sólo se guarda el hash SHA-256; la key real se muestra una sola vez al crearla y no se persiste.

### 2.2 Credenciales del contribuyente

Van en el body de cada request, no en un login previo. **No hay endpoint de sesión ni token de contribuyente**: cada llamada se autentica sola.

Hay tres regímenes según la ruta, y mezclarlos es el error de integración más común:

| Régimen | Rutas | Qué acepta |
|---|---|---|
| **Clave o certificado** | casi todas: `/v1/bhe/*`, `/v1/rcv/*`, `/v1/renta/*`, `/v1/dte/*`, y las dos lecturas de `/v1/mipyme/*` | `clave`, **o** `certificado_base64` + `certificado_password`. Exactamente una de las dos. |
| **Sólo certificado** | `/v1/mipyme/emitir-dte` | `certificado_base64` + `certificado_password`, ambos obligatorios. Firmar un DTE necesita el certificado de verdad, no basta una sesión autenticada. |
| **Sólo clave** | `/v1/persona/bienes-raices`, `/v1/sesion/validar-clave` | `clave` obligatoria. No acepta certificado. |

En el régimen mixto, la validación rechaza:

- `clave` junto con **cualquier** campo de certificado, aunque el par esté incompleto.
- Un certificado a medias (sólo `base64`, o sólo `password`) sin `clave`.
- No mandar ninguna.

`certificado_base64` se sanea quitándole todo el whitespace antes de validar contra `/^[A-Za-z0-9+/]+={0,2}$/`, así que un PEM con saltos de línea pasa sin problema.

### 2.3 Validar una clave antes de guardarla

```bash
curl -X POST https://mcp-sii.redcomercio.cl/v1/sesion/validar-clave \
  -H "Authorization: Bearer $MCP_SII_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"rut":"11111111-1","clave":"..."}'
```

Responde `{"ok":true}` o `{"ok":false,"error":"CREDENCIALES_INVALIDAS"}`. Sirve para no guardar una clave que el SII va a rechazar después.

También puede responder `SESIONES_SIMULTANEAS` o `LIMITE_SII`, y en esta ruta la distinción es la que más importa: **ninguno de los tres significa "la clave es dudosa"**. La clave puede estar perfecta y el problema ser que hay otra consulta en curso sobre el mismo RUT, o que el SII nos está cortando por volumen. **Sólo `CREDENCIALES_INVALIDAS` autoriza a descartar una clave**; con los otros tres, reintentá — y con `LIMITE_SII`, esperando minutos.

---

## 3. El contrato de respuesta

**Éxito — HTTP 200:**

```json
{ "ok": true, "campo": "...", "otro": 123 }
```

Los campos del resultado se ponen al mismo nivel que `ok`. **Si el resultado es una lista, se envuelve en `datos`:**

```json
{ "ok": true, "datos": [ { ... }, { ... } ] }
```

Sólo tres rutas devuelven `datos`: `/v1/bhe/list-emitidas`, `/v1/bhe/list-recibidas` y `/v1/mipyme/list-empresas`.

**Error de negocio — también HTTP 200:**

```json
{ "ok": false, "error": "CODIGO" }
{ "ok": false, "error": "CODIGO", "detalle": "explicación en castellano" }
```

Esto es lo que más sorprende al integrar: **un fallo del SII no es un error HTTP.** El status 200 significa "el servicio funcionó"; que la consulta haya salido bien lo dice `ok`. Ramificá siempre por `ok`, nunca por el status.

**Errores de transporte y validación — status ≠ 200, y sin campo `ok`:**

```json
{ "error": "CODIGO" }
{ "error": "BAD_REQUEST", "detalle": "anio: Number must be greater than or equal to 2000" }
```

Un cliente robusto lee `body.ok === true` para el camino feliz y `body.error` para todo lo demás, sin mirar el status salvo para distinguir 429.

---

## 4. Códigos de error

| Código | Status | `detalle` | Qué pasó | ¿Reintentar? |
|---|---|---|---|---|
| `ERROR` | 200 | no | Fallo no clasificado: timeout, red, portal caído. | **Sí.** El único reintentable. |
| `CREDENCIALES_INVALIDAS` | 200 | no | El SII rechazó la clave o el certificado. | No. Pedí credenciales nuevas. |
| `SESIONES_SIMULTANEAS` | 200 | **sí** | El RUT ya tiene demasiadas sesiones abiertas en el SII. | **Sí**, después de esperar. |
| `LIMITE_SII` | 200 | **sí** | El SII cortó las consultas por volumen (su propio error 429). | **Sí, pero esperando de verdad.** |
| `SERVICIO_OCUPADO` | 200 | **sí** | **Nosotros** estamos ocupados: hay demasiadas consultas de indicadores esperando turno. | **Sí**, en segundos. |
| `NO_ENCONTRADO` | 200 | **sí** | El SII confirmó que el dato no existe. | No, es permanente. |
| `LIMITE_CONOCIDO` | 200 | **sí** | Límite conocido de lo que se puede leer del portal (ver §7). | No, es permanente. |
| `BAD_REQUEST` | 400 | **sí** | El body no valida. El `detalle` nombra el campo. | No, arreglá el request. |
| `CONFIRMAR_NO_SOPORTADO` | 400 | no | Mandaste `confirmar:true` a `emitir-dte`. | No, ver §6.5. |
| `UNAUTHORIZED` | 401 | no | Falta el header, no es `Bearer`, o la key es desconocida o está revocada. | No. |
| `PAYLOAD_TOO_LARGE` | 413 | no | Body de más de 64 KiB. | No. |
| `RATE_LIMITED` | 429 | no | Excediste el límite (ver §5). | Sí, después de la ventana. |
| `ERROR` | 500 | no | Excepción no controlada del servidor. | Quizá. |
| *(sin cuerpo)* | 404 | — | Ruta o método no registrado. | No. |

Dos precisiones que evitan bugs:

- **`LIMITE_SII` significa parar, no reintentar rápido.** El SII cortó por volumen de consultas. Reintentar de inmediato es lo que mantiene el corte: hay que esperar de verdad —minutos, no segundos— y bajar el ritmo. Aparece cuando se le hacen muchas consultas al mismo portal en poco tiempo, y afecta a ese portal entero mientras dura.
- **`SERVICIO_OCUPADO` es nuestro, no del SII, y se espera en segundos.** Las rutas de indicadores serializan sus bajadas contra el portal público a propósito: un barrido en paralelo es lo que hace que el SII corte por volumen. Cuando hay demasiadas esperando turno, preferimos rechazar rápido antes que dejarte la conexión abierta varios minutos sin decirte nada. Reintentá en unos segundos; si aparece seguido, el que está pidiendo de más probablemente seas vos.
- **`ERROR`, `SESIONES_SIMULTANEAS`, `LIMITE_SII` y `SERVICIO_OCUPADO` son los cuatro que conviene reintentar**, con esperas muy distintas. `NO_ENCONTRADO` y `LIMITE_CONOCIDO` son determinísticos: el mismo request va a fallar igual siempre, y reintentarlos sólo gasta sesiones del SII.
- **`SESIONES_SIMULTANEAS` merece su propio mensaje al usuario.** Reintentar es correcto igual que con `ERROR`, así que el comportamiento no cambia — lo que cambia es lo que le podés decir a la persona. Con `ERROR` sólo cabe "probá de nuevo en unos minutos"; con éste podés decirle que hay **otra consulta en curso sobre el mismo contribuyente**, y eso es accionable: sabe que dejó otra pestaña abierta, o que un colega está mirando el mismo caso. Aparece cuando el RUT supera el límite de sesiones simultáneas del SII.

  Con una salvedad: hoy se detecta al **abrir** la sesión, que es donde el portal lo informa. Si el bloqueo apareciera a mitad de una consulta ya en curso, todavía llega como `ERROR`. O sea que `SESIONES_SIMULTANEAS` confirma el caso, pero su ausencia no lo descarta.
- **`detalle` es para humanos, no para parsear.** Es texto en castellano explicando qué pasó y qué se puede hacer. Mostralo; no ramifiques sobre su contenido.

---

## 5. Límites y tiempos

| Límite | Valor | Al excederlo |
|---|---|---|
| Requests por minuto y por tenant | Configurable, **60 por defecto** | `429 RATE_LIMITED` |
| Fallos de autenticación por IP | 20 por minuto | `429 RATE_LIMITED` |
| Tamaño del body | 64 KiB | `413` |
| Timeout del request | 35 s | Se corta la conexión |
| Timeout de los headers | 10 s | Se corta la conexión |
| Respuesta del SII | 4 MiB | `LIMITE_CONOCIDO` |

La ventana del rate limit es de un minuto fijo, truncando segundos: no es deslizante. **No se manda header `Retry-After`**; si necesitás esperar, esperá hasta el próximo minuto de reloj.

Dos detalles del diseño que te favorecen:

- **Un body inválido no gasta cupo.** El límite del tenant se chequea después de parsear el body, a propósito.
- **Sólo los fallos de auth suman al contador por IP.** Un request autenticado con éxito nunca incrementa ese contador.

**No hay CORS.** Un `OPTIONS` cae en el 404 de ruta no registrada, así que esta API no se puede llamar desde un browser: es para servidor a servidor. Es lo correcto — las credenciales del SII no deberían pasar nunca por un cliente.

**Cuidado con la query string.** El ruteo compara el path exacto: `/v1/bhe/resumen?x=1` **no matchea** y devuelve 404. Mandá todo en el body.

---

## 6. Endpoints

Todos son `POST` con `Content-Type: application/json`, salvo `/health`.

En todos, `rut` es un string obligatorio. **No se valida el formato ni el dígito verificador**, así que un RUT mal formado no da `BAD_REQUEST`: falla más adelante como error de autenticación del SII.

### `GET /health`

Sin autenticación. Responde `200` sin cuerpo si el servicio y la base están sanos, `503` si no.

---

### 6.1 Boletas de honorarios (BHE)

Las cinco aceptan **clave o certificado**. Cuelgan de la persona natural, no de una empresa.

#### `POST /v1/bhe/resumen` — informe anual de emitidas

| Campo | Tipo | |
|---|---|---|
| `rut` | string | obligatorio |
| `anio` | int 2000–2100 | obligatorio |

```bash
curl -X POST https://mcp-sii.redcomercio.cl/v1/bhe/resumen \
  -H "Authorization: Bearer $MCP_SII_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"rut":"11111111-1","clave":"...","anio":2026}'
```

Respuesta:

```json
{
  "ok": true,
  "anio": 2026,
  "rut": "11111111-1",
  "nombreContribuyente": "NOMBRE APELLIDO",
  "folioInicial": 324,
  "folioFinal": 340,
  "meses": [
    { "mes": 1, "honorarioBruto": 4391291, "retencionTerceros": 669672,
      "retencionContribuyente": 0, "totalLiquido": 3721619,
      "folioInicial": 324, "folioFinal": 324,
      "emisionesVigentes": 1, "emisionesAnuladas": 0 },
    { "mes": 2, "...": "..." }
  ]
}
```

**`meses` trae siempre los doce, en orden.** Un mes sin actividad viene en cero y con los folios en `null`. O sea que `meses[i]` es siempre el mes `i+1` y podés indexar directo — pero `meses.length` es 12 fijo y no sirve para contar meses facturados. Para eso:

```js
meses.filter(m => m.emisionesVigentes > 0 || m.emisionesAnuladas > 0)
```

Los folios van en `null` y no en `0` porque no hubo folio: un `0` ahí sería un número de folio inventado.

**`totalLiquido` lo calculamos nosotros** (bruto menos las dos retenciones); el SII no lo manda en los datos, lo calcula el JavaScript de su propio informe. Verificado contra la columna "TOTAL LÍQUIDO" del portal.

#### `POST /v1/bhe/resumen-recibidas` — informe anual de recibidas

Mismos campos y misma forma de respuesta que `/v1/bhe/resumen`, con una excepción: **`folioInicial` y `folioFinal` vienen siempre en `null`**, tanto por mes como del año. El portal no muestra folios en el informe de recibidas, y un rango no significaría nada ahí: cada boleta la folió un emisor distinto.

> **No equivale a sumar `list-recibidas`, y no se puede derivar de ahí.** Son dos informes distintos del SII, y el anual informa una `retencionContribuyente` que el informe mensual de recibidas no muestra. Caso real de 07/2026: el anual da **19.063** de retención, y las cuatro boletas del mensual muestran **"Retenido 0"** — en el portal y en esta API por igual. Si necesitás la retención de boletas recibidas, sale de este endpoint y de ningún otro.

#### `POST /v1/bhe/list-emitidas` y `POST /v1/bhe/list-recibidas`

| Campo | Tipo | |
|---|---|---|
| `rut` | string | obligatorio |
| `anio` | int 2000–2100 | obligatorio |
| `mes` | int 1–12 | obligatorio |

Devuelven `{"ok":true,"datos":[...]}` con objetos así:

```json
{
  "folio": 337,
  "codigoBarras": "22222222000004AB19C",
  "fecha": "08/07/2026",
  "fechaEmision": "08/07/2026",
  "contraparteRol": "receptor",
  "contraparteRut": "22222222-2",
  "contraparteNombre": "RAZON SOCIAL SA",
  "emailEnvio": "",
  "sociedadProfesional": false,
  "usuarioEmisor": "NOMBRE APELLIDO",
  "honorarioBruto": 2041016,
  "retencionEmisor": 0,
  "retencionReceptor": 311255,
  "totalLiquido": 1729761,
  "anulada": false
}
```

Diferencias entre emitidas y recibidas que hay que respetar:

| Campo | En emitidas | En recibidas |
|---|---|---|
| `contraparteRol` | `"receptor"` | `"emisor"` |
| `retencionEmisor` | número | **`null`** — el SII no lo informa |
| `fechaEmision` | fecha | **`""`** |
| `usuarioEmisor` | nombre | **`""`** |
| `emailEnvio` | mail o `""` | **`""`** |

`retencionEmisor: null` significa "el SII no informa este dato", que es distinto de un cero informado. No lo trates como 0.

`contraparteNombre` viene **truncado a 30 caracteres** (`CONSERVADOR DE BIENES RAICES D`). Es del SII, no nuestro: el portal muestra exactamente lo mismo.

Las fechas son **`DD/MM/AAAA`**, no ISO.

> `list-recibidas` falla con `LIMITE_CONOCIDO` si el mes tiene **más de 100 boletas recibidas**. Ver §7.

#### `POST /v1/bhe/pdf` — el PDF de una boleta

| Campo | Tipo | |
|---|---|---|
| `rut` | string | obligatorio |
| `codigo_barras` | string, sólo letras y dígitos, máx. 40 | obligatorio |
| `recibida` | boolean | opcional, default `false` |

> **El identificador es `codigoBarras`, no el folio.** El folio no sirve. Sacá el código del listado mensual correspondiente.

Respuesta:

```json
{
  "ok": true,
  "codigo_barras": "22222222000004AB19C",
  "content_type": "application/pdf",
  "nombre_archivo": "bhe-22222222000004AB19C.pdf",
  "tamano_bytes": 8432,
  "pdf_base64": "JVBERi0xLjMK..."
}
```

El PDF viaja en base64 dentro del JSON, no como cuerpo binario: todo el contrato es `{ok}` con status 200, y una ruta que devolviera `application/pdf` no podría expresar `{ok:false}`. Una boleta pesa ~8 KB en la práctica.

Si pedís una boleta **recibida** con `recibida:false` (o al revés), el SII responde exactamente igual que si no existiera: `NO_ENCONTRADO`. Si esperabas encontrarla, revisá ese flag antes que nada.

---

### 6.2 Registro de compras y ventas (RCV)

**Clave o certificado.** Campos comunes:

| Campo | Tipo | |
|---|---|---|
| `rut` | string | obligatorio |
| `periodo` | string `AAAAMM` | obligatorio |
| `operacion` | `"COMPRA"` \| `"VENTA"` | obligatorio |
| `empresa_rut` | string | opcional — por defecto, el RUT autenticado |

#### `POST /v1/rcv/resumen`

```json
{
  "ok": true,
  "empresaRut": "77777777-7",
  "periodo": "202607",
  "operacion": "COMPRA",
  "sinDatos": false,
  "mensaje": null,
  "totalDocumentos": 42,
  "actualizadoAl": "2026-08-01",
  "filas": [
    { "tipoDocCodigo": 33, "tipoDocNombre": "Factura Electrónica",
      "documentos": 40, "montoNeto": 1000000, "montoExento": 0,
      "montoIva": 190000, "montoTotal": 1190000,
      "esNotaCredito": false, "tipoDesconocido": false }
  ],
  "totales": { "neto": 1000000, "exento": 0, "iva": 190000, "total": 1190000 },
  "totalesConfiables": true,
  "tiposDesconocidos": [],
  "advertencias": []
}
```

Tres campos que hay que mirar antes de usar los totales:

- **`totalesConfiables: false`** significa que hay tipos de documento cuyo signo no conocemos, así que los totales pueden estar mal. Los tipos en cuestión están en `tiposDesconocidos`. **No presentes los totales como definitivos si esto es `false`.**
- Cada fila trae además **`montoIvaUsoComun` y `montoIvaNoRecuperable`**, y los totales suman `ivaUsoComun` e `ivaNoRecuperable` con el mismo criterio de signo que el resto (las notas de crédito restan). Son los que faltaban para cuadrar un crédito fiscal.
- **`sinDatos: true`** es un período legítimamente vacío, no un error.
- **`esNotaCredito: true`** en una fila significa que **resta** del total.

#### `POST /v1/rcv/tipos-documento`

Sólo `rut` más la credencial. Devuelve `{"ok":true,"datos":[…]}` con los 46 tipos
de documento que conoce el registro: `codigo`, `nombre` y `tipoIngreso`
(`DET_ELE` electrónico, `DET_PAP` papel, `RESUMEN` para los totales de boletas —
crudo, tal como lo llama el SII).

Existe porque `/v1/rcv/detalle` **exige** un `tipo_doc` y no hay "detalle del
período entero": sin este catálogo hay que adivinar los códigos, o sacarlos de un
resumen que sólo lista los tipos con movimiento en ese período.

> Trae código y nombre, **no el signo**. Que exista el tipo 61 no dice que las
> notas de crédito resten: eso lo resuelve el resumen con `esNotaCredito`.

#### `POST /v1/rcv/empresas-autorizadas`

Sólo `rut` más la credencial. Devuelve `{"ok":true,"datos":[…]}` con las
empresas que ese RUT puede **consultar** en el registro de compras y ventas.

> **No es lo mismo que `/v1/mipyme/list-empresas`.** Ésas son las empresas que
> la persona puede **operar** en el portal de facturación gratuita; éstas, las
> que puede **consultar** en el RCV. Un RUT puede estar en una lista y no en la
> otra — en las pruebas, 5 en mipyme contra 17 acá. Confundirlas llevaría a
> ofrecer facturar por una empresa que sólo se puede mirar.

Cada entrada trae `rut` y, en `null`, `razonSocial`, `privilegios` y las dos
fechas de desautorización: **el SII no informa esos datos por esta vía**. Van en
`null` en vez de omitirse para que se vea que el dato existe y esta consulta no
lo trae. Para el nombre de un RUT está `/v1/contribuyente/situacion-tributaria`,
que además no pide credencial.

#### `POST /v1/rcv/detalle`

Agrega `tipo_doc` (int positivo, obligatorio) a los campos comunes. Devuelve `documentos` con una fila por documento:

```json
{
  "contraparteRut": "55555555-5",
  "contraparteTipoId": "extranjero",
  "contraparteIdExtranjero": "ABC123",
  "contraparteNacionalidadCodigo": 218,
  "contraparteNombre": "PROVEEDOR EXTERIOR",
  "contraparteRol": "emisor",
  "folio": 1234,
  "fechaEmision": "15/07/2026",
  "montoNeto": 100000, "montoExento": 0, "montoIva": 19000, "montoTotal": 119000,
  "referenciaTipoDoc": null, "referenciaFolio": null,
  "eventoReceptor": null
}
```

**El detalle trae 26 campos, no 15.** Además de los de arriba, cada documento
informa los datos tributarios que el portal muestra y que antes se descartaban:
`fechaRecepcion`, `fechaAcuse`, `montoIvaNoRecuperable` con
`codigoIvaNoRecuperable`, `montoNetoActivoFijo`, `montoIvaActivoFijo`,
`montoIvaUsoComun`, `montoSinDerechoACredito`, `montoIvaNoRetenido`, los tres
montos de tabaco y `tipoTransaccion`. Para armar un F29 no son opcionales: el
IVA no recuperable, el de uso común y el de activo fijo cambian el crédito
fiscal.

Dos criterios que conviene tener claros al leerlos:

- **Los montos vienen en `0` y los códigos en `null`.** El SII manda 0 cuando el
  concepto no aplica al documento, y ahí el cero **es** el dato. Un código en 0
  no sería "código cero" sino "no hay", así que va `null`.
- **`fechaRecepcion` trae hora y `fechaEmision` no** (`23/06/2026 12:51:37`
  contra `23/06/2026`). Son dos formatos distintos en la misma fila, tal como
  los manda el SII; no los normalizamos para que la diferencia se vea en vez de
  que la descubras parseando.

Los "otros impuestos" (código, valor y tasa) que muestra el portal **todavía no
se exponen**: los campos candidatos del SII no se pudieron verificar contra un
documento que realmente tenga uno, y mapearlos a ciegas publicaría un impuesto
inexistente en cada documento.

Trampas de este endpoint:

- **En exportaciones, `contraparteRut` es el genérico `55555555-5` para todo extranjero.** Mirá `contraparteTipoId` antes de usar el RUT como identidad, o vas a fusionar contrapartes distintas en una.
- `contraparteNacionalidadCodigo` es el **código numérico** de la tabla de países del SII (218 = Ecuador), no un nombre.
- **`eventoReceptor: null` significa que no hubo evento registrado, no "aceptado".**
- `totalDocumentos` lo contamos nosotros; el SII no da un total propio. Verificado hasta 393 documentos, **sin garantía de paginación por encima de eso**.

---

### 6.3 Documentos tributarios electrónicos (DTE)

**Clave o certificado.**

#### `POST /v1/dte/list-documentos-emitidos` y `.../list-documentos-recibidos`

| Campo | Tipo | |
|---|---|---|
| `rut` | string | obligatorio |
| `periodo` | string `AAAAMM` | obligatorio |
| `empresa_rut` | string | opcional |
| `tipo_doc` | int positivo | opcional |
| `seccion` | string | opcional — `S1`/`S2`/`S4`/`S5` |
| `contraparte_rut` | string | opcional — **exige `incluir_detalle:true`** |
| `limit` | int 1–500 | opcional — **exige `incluir_detalle:true`** |
| `incluir_detalle` | boolean | opcional, default `false` |

> `contraparte_rut` y `limit` filtran sobre el detalle. Sin detalle no hay nada que filtrar, así que la llamada **falla** con `LIMITE_CONOCIDO` en vez de devolverte el resumen completo del período, que se leería como si el filtro se hubiera aplicado.

Campos de la respuesta que dicen algo que no es obvio:

- **`totales: null` no significa cero pesos**: significa que no se pidió detalle y no hay nada que sumar.
- **`origenDeMontos`** dice de dónde salen los montos: `declarados_por_el_sii`, `suma_de_documentos` o `sin_montos`. Los declarados no son auditables contra los documentos.
- **`filtroContraparteSinCoincidencias`**: `null` = no se filtró; `true` = el período tiene documentos pero ninguno de esa contraparte.
- **`totalesDifierenDelDeclarado: false`** también es lo que ves cuando no hay con qué comparar.
- En `filas`, **la clave es el par `(tipoDocCodigo, seccion)`, no el tipo solo.**
- `documentosTruncados: true` significa que `limit` cortó el listado.

#### `POST /v1/dte/get-documento-emitido` y `.../get-documento-recibido`

`rut`, `periodo`, `tipo_doc` y `folio` obligatorios; `empresa_rut` opcional.

> **`encontrado: false` no es un error.** El folio puede existir pero pertenecer a otro período. La respuesta trae `documento: null` y un `mensaje`.

---

### 6.4 Renta

**Clave o certificado.**

#### `POST /v1/renta/estado-declaracion`

`rut` y `anio` (int 2000–2100).

```json
{
  "ok": true, "anio": "2026", "sinDatos": false,
  "declaraciones": [
    { "folio": 123456789, "periodo": "2026", "vigente": true,
      "estadoCodigo": "IPG", "codigoConclusion": "01",
      "contribuyente": "...", "comuna": "...", "direccion": "...",
      "fechaVencimiento": "...", "remanenteSolicitado": 0, "remanenteDevuelto": 0 }
  ],
  "glosas": [ { "codigoConclusion": "01", "descripcion": "..." } ]
}
```

**`estadoCodigo` es la sigla cruda del SII** (`IPG`, `ODT`, `NST`), deliberadamente sin traducir: inventar una traducción sería inventar semántica tributaria. Para el texto, cruzá `codigoConclusion` contra `glosas`.

Un año puede tener **varias declaraciones**, y sólo una con `vigente: true`.

#### `POST /v1/renta/f22`

`rut`, `anio`, y `folio` opcional (por defecto, la declaración vigente del año). Devuelve `lineas` con `{codigo, valor, glosa}` — los códigos del formulario 22. **`valor` es string**, tal como lo entrega el SII.

---

### 6.5 Mipyme

**Clave o certificado.**

- **`POST /v1/mipyme/list-empresas`** — sólo `rut`. Devuelve `{"ok":true,"datos":[{"rut","nombre"}]}`.
- **`POST /v1/mipyme/list-dte-emitidos`** — `rut` obligatorio; opcionales `empresa_rut`, `tipo_dte`, `fecha_desde` y `fecha_hasta` (`AAAA-MM-DD`), `receptor_rut`, `folio`, y `pagina` (default `1`, 100 documentos por página).

  `totalPaginas` puede venir **`null`**: significa que el HTML no traía la leyenda "Página X de Y", así que no se puede afirmar cuántas hay. No lo interpretes como una sola página.

  Cada documento trae un **`codigo`**, que es un identificador interno del SII: no es el folio ni se deriva de la fila, y es el único parámetro que acepta el CGI de detalle.

- **`POST /v1/mipyme/emitir-dte`** — previsualización solamente.

> **La emisión real no está disponible por REST.** `confirmar:true` se rechaza con `400 CONFIRMAR_NO_SOPORTADO`. Firmar un DTE requiere la clave del certificado, que hoy sólo se configura por variables de entorno del proceso — incompatible con credenciales por request. Con `confirmar:false` (el default) devolvés una previsualización con `emitido: false`, el resumen del documento y los campos del formulario. **Nada se emite ante el SII.**

---

### 6.6 Persona

**`POST /v1/persona/bienes-raices`** — credencial estándar (clave **o** certificado; antes sólo clave).

Devuelve `resumen` (`totalBienesRaices`, `solicitudesEnCurso`, `solicitudesResueltas`, `notificaciones`, `afectoSobretasa`, `beneficioAdultoMayor`) y `propiedades`, con `comuna`, `rol`, `direccion`, `destino`, `fojas`, `numero`, `anio` (todos string, **incluido `anio`**), `porcentajeDerechos` y `avaluoFiscal` numéricos, **más** los códigos del catastro que piden las rutas de abajo: `comunaCodigo`, `manzana`, `predio`, `ultimoEacAplicado`. El `rol` "00632-00244" es `manzana`-`predio` con ceros a la izquierda.

### 6.7 Bienes raíces

Todas con credencial estándar. Un predio se identifica por **`comuna`** (código SII, el de `/comunas`), **`manzana`** y **`predio`**, los tres enteros.

| Endpoint | Body además de la credencial | Devuelve |
|---|---|---|
| **`POST /v1/bienes-raices/comunas`** | — | `datos`: `{codigo, nombre, regional}` |
| **`POST /v1/bienes-raices/consultar-rol`** | `comuna`, `manzana`, `predio` | `datos`: `{comuna, rol, direccion, destino, avaluoFiscal, contribuciones}` de un predio **cualquiera** (no hace falta ser el dueño). Rol inexistente → `NO_ENCONTRADO`. |
| **`POST /v1/bienes-raices/multipropietarios`** | `comuna`, `manzana`, `predio` | `datos`: `{rut, nombre, porcentajeDerechos, fojas, numero, anio, fechaInscripcion}` |
| **`POST /v1/bienes-raices/solicitudes`** | — | `datos`: historial de certificados pedidos: `{id, fecha, finVigencia, estado, tipo, folio, codigoVerificacion, url}` |
| **`POST /v1/bienes-raices/documento`** | `url` (la de una solicitud, tal cual) | `pdf_base64`, `content_type`, `nombre_archivo`, `tamano_bytes` |
| **`POST /v1/bienes-raices/certificado-avaluo`** | `bienes: [{comuna, manzana, predio, ultimo_eac_aplicado}]`, `tipo` (`simple` default, `multipropietario`, `detallado`) | ídem PDF, más `tipo` |

Dos cosas al integrar:

- **`certificado-avaluo` es una solicitud real** que queda en el historial del contribuyente (aparece en `/solicitudes`). No tiene costo ni es un acto tributario, pero no es una lectura: no la repitas en cada carga de pantalla. `ultimo_eac_aplicado` sale del listado de propiedades; no se inventa.
- **`avaluoFiscal` y `contribuciones` de `consultar-rol` son strings** con el formato del portal (`"51.230.998"`), porque esa consulta es la de terceros y el SII la publica formateada. En el listado propio `avaluoFiscal` es numérico.

---

### 6.7 Indicadores y valores publicados

Los **únicos** endpoints del servicio que no reciben `rut` ni credencial: el SII
publica estas tablas abiertas y no hay sesión que abrir. Siguen pidiendo la API
key del tenant y contando contra el rate-limit, como todos.

Todos toman un solo campo: `anio` (entero, 1990–2100).

| Endpoint | Devuelve |
|---|---|
| **`POST /v1/indicadores/uf`** | Una entrada por día: `mes`, `dia`, `valor` |
| **`POST /v1/indicadores/dolar`** | Ídem, dólar observado; **sólo días hábiles** |
| **`POST /v1/indicadores/utm`** | Una entrada por mes: `mes`, `valores` (lista) |
| **`POST /v1/indicadores/correccion-monetaria`** | Ídem, factores por mes |
| **`POST /v1/indicadores/impuesto-2da-categoria`** | Tramos del art. 43 |
| **`POST /v1/indicadores/impuesto-2da-categoria-art52`** | Tramos del art. 52 bis |

```json
POST /v1/indicadores/uf   {"anio": 2025}
{"ok": true, "datos": [{"mes": 1, "dia": 1, "valor": 38384.41}, ...]}
```

Cuatro cosas al integrarlas:

- **Un día que el SII no publicó no aparece**, en vez de venir en cero: feriados
  y fines de semana en el dólar, y los días que al año en curso todavía le faltan.
  Recorrer el array por índice asumiendo `dia === indice + 1` se rompe; hay que
  leer el campo `dia`.
- **`utm` y `correccion-monetaria` devuelven `valores` como lista sin nombres.**
  Las columnas cambian entre tablas, y ponerles nombre acá sería inventar
  semántica: el orden es el de la tabla del portal. En corrección monetaria la
  tabla es triangular, así que muchos vienen en `null`, y ese `null` significa
  "no corresponde", no cero.
- **En los tramos de 2ª categoría, el tramo exento trae `exento: true` con
  `factor`, `rebaja` y `tasaMaxima` en `null`** — no en 0, porque un factor 0
  daría el mismo impuesto por un camino que la tabla no afirma. El art. 43 trae
  los cuatro períodos (`MENSUAL`, `QUINCENAL`, `SEMANAL`, `DIARIO`) y el art. 52
  bis sólo `MENSUAL`. El último tramo de cada período no tiene tope superior:
  `hasta` va en `null`.
- **Un año que el SII no publica devuelve `NO_ENCONTRADO`**, no un array vacío.

El servicio cachea por año e indicador: un año ya cerrado no se vuelve a
consultar nunca, y el año en curso se revisa cada seis horas. Aun así, conviene
pedir el año una vez y resolver los días en memoria: cada llamada baja una página
completa del SII, y el SII corta por volumen (`LIMITE_SII`).

### 6.8 Tasación de vehículos

Sin `rut` ni credencial. Fuente: las planillas XLSX anuales del SII (`liv{año}.xlsx`, `pes{año}.xlsx`, desde 2020); la consulta interactiva del portal exige captcha y no se usa. Todas toman `anio` (el de la planilla, 2020–2100) y `categoria` (`liviano` default, `pesado`). **La primera consulta de un año tarda unos segundos** (baja ~7 MB); después es de memoria.

| Endpoint | Body además de `anio`/`categoria` | Devuelve |
|---|---|---|
| **`POST /v1/vehiculos/tipos`** | — | `datos`: string[] |
| **`POST /v1/vehiculos/marcas`** | `tipo?` | `datos`: string[] |
| **`POST /v1/vehiculos/modelos`** | `marca` | `datos`: `{modelo, versiones[], aniosFabricacion[]}`; marca inexistente → `NO_ENCONTRADO` |
| **`POST /v1/vehiculos/tasacion`** | `codigo_sii`, **o** `marca`+`modelo` (+`version`, +`anio_fabricacion`) | `datos`: una fila por año de fabricación y versión: `codigoSii, anioFabricacion, tipo, marca, modelo, version, puertas, cilindrada, potencia, combustible, transmision, marchas, traccion, pais, equipamiento, carga, pasajeros, tasacion, permiso, observacion` |
| **`POST /v1/vehiculos/equipamiento`** | — | `datos`: `{sigla, descripcion}` |

Dos cosas: **`tasacion` devuelve todas las filas que coinciden** (un modelo tiene una por año de fabricación y por versión) en vez de elegir una; y **livianos y pesados traen columnas distintas**: pesados tiene `carga`/`pasajeros` y `permiso: null`; livianos, `puertas`/`potencia`/`combustible`/`permiso` y `carga`/`pasajeros` en `null`. `null` es ausencia en la planilla, no cero.

### 6.9 Contribuyentes (sin credencial) y Mi SII

| Endpoint | Body | Devuelve |
|---|---|---|
| **`POST /v1/contribuyentes/actividades-economicas`** | `categoria?` (`"1"`, `"2"` u otro valor de la tabla), `afecta_iva?`, `texto?` | `datos`: `{codigo, descripcion, rubro, subrubro, afectaIva, categoriaTributaria, disponibleInternet}` |
| **`POST /v1/contribuyentes/actividad-economica`** | `codigo` (seis dígitos) | una actividad; inexistente → `NO_ENCONTRADO` |
| **`POST /v1/contribuyentes/verificar-rut`** | `rut` | `{rut, valido, cuerpo, dv, motivo?}`. **No consulta al SII** ni dice si el RUT existe: sólo módulo 11. |
| **`POST /v1/misii/datos-contribuyente`** | credencial estándar | la ficha de Mi SII: `rut, razonSocial, nombres, tipoContribuyente, subtipoContribuyente, personaEmpresa, segmento, glosaActividad, email, telefonoMovil, fechaConstitucion, fechaInicioActividades, fechaTerminoGiro, unidadOperativa, capitalEnterado, capitalPorEnterar, autorizadoDeclararDia20, actividades[], regimen, direcciones[], atributos[], alertas[]`, más `capturadoEn` y `parserVersion` |

`categoriaTributaria` es texto y viene tal como la publica el SII: la mayoría `"1"` o `"2"`, y alguna letra (`"G"`) que la tabla no explica. `atributos` son los regímenes y autorizaciones del contribuyente (por ejemplo `14D1` "Régimen Pro Pyme General") con `desde`/`hasta`. **Todas las fechas van en `YYYY-MM-DD`**: el SII las manda en dos formatos distintos dentro de la misma ficha y acá se normalizan.

`actividades[]` son las actividades económicas de ESTE contribuyente —`{codigo, giro, categoria, afectaIva, desde}`—, que no es lo mismo que el catálogo público de `/v1/contribuyentes/actividades-economicas`: acá viene la fecha desde la que el contribuyente tiene cada una. El **código va como string**, no como número: varios códigos ACTECO empiezan con cero (`011101` es cultivo de trigo) y convertirlos se lo come.

`capturadoEn` es **cuándo se leyó del SII**, no cuándo se armó la respuesta, y `parserVersion` viaja para poder auditar hacia atrás un dato que después resulte estar mal. Guardá los dos con cada captura.

**Sobre `regimen`, y conviene leerlo entero antes de usarlo:**

- Es el régimen **VIGENTE**, derivado del atributo `14*`, y el portal **no guarda el anterior**. Verificado con un caso real: una empresa que cambió de régimen no deja ningún rastro del que tenía antes.
- Por eso `regimen.desde` **no es decorativo**: es el único dato que dice para qué períodos vale la respuesta. **Para un período anterior a esa fecha éste NO es el régimen que corresponde** — hay que buscarlo en otra fuente y nunca extrapolar el actual hacia atrás. Un F29 calculado así sale con el régimen equivocado y sin ninguna señal de error.
- `regimen: null` significa "no se pudo determinar". No es un régimen por defecto y no debe tratarse como uno.
- El código va **tal como lo da el SII** (`14D1` y su glosa), sin traducirlo a una clasificación propia: sólo se relevó uno, y clasificar los demás a ciegas daría un régimen plausible y equivocado.

La respuesta trae datos personales (correo, teléfono, capital): **loguearla entera es loguear PII**.

### 6.10 Verificación de DTE

Credencial estándar (eran públicas; el SII las cerró detrás del login). `tipo_dte` sólo acepta los que el formulario del SII ofrece: 33, 34, 46, 52, 56, 61, 43, 110, 111, 112.

| Endpoint | Body | Devuelve |
|---|---|---|
| **`POST /v1/dte/validez`** | `rut_emisor`, `tipo_dte`, `folio` | `recibidoPorElSii`, `resultado` ("Documento recibido por el SII" / "Documento no autorizado"), `emisorNombre`, `identificadorEnvio` (`**********` si no existe), `rutEmisor`, `tipoDteNombre`, `folio`, `comprobante` |
| **`POST /v1/dte/verificar`** | ídem + `rut_receptor`, `fecha_emision` (YYYY-MM-DD), `monto_total` | ídem + `datosCoinciden`, `fechaEmision`, `rutReceptor`, `montoTotal` |

`datosCoinciden` es el veredicto que importa: `resultado` dice "Datos coinciden con los registrados" o "Documento recibido por el SII pero datos NO coinciden con los registrados", y cuando no coinciden el SII **omite el nombre del emisor**. Un folio inexistente no es un error: es `recibidoPorElSii: false` con "Documento no autorizado".

---

## 7. Limitaciones conocidas

Todas devuelven `200` con `{"ok":false,"error":"LIMITE_CONOCIDO","detalle":"..."}`. **Ninguna se arregla reintentando.**

| Condición | Rutas afectadas | Qué hacer |
|---|---|---|
| Descuadre de conteo: el SII informó N boletas y se recuperaron M, o hubo filas sin folio, o duplicados. | listados BHE | Reportar. No se devuelve un listado incompleto ni con duplicados. |
| El informe anual trae datos para un mes pero ningún folio legible. **Se aborta el año entero.** | `/v1/bhe/resumen`, `/resumen-recibidas` | Reportar. |
| El CGI cambió de formato (falta `CantidadFilas`). | consultas mensuales BHE | Reportar: hay que actualizar el scraper. |
| `contraparte_rut` o `limit` sin `incluir_detalle:true`. | listados DTE | Arreglar el request. |
| La respuesta del SII superó 4 MiB. | cualquiera, típicamente `/v1/bhe/pdf` | Reportar. |

**Sobre `/v1/bhe/list-recibidas` con más de 100 boletas en el mes:** antes fallaba explícito; ahora pagina encadenando el código de continuación del informe (`pagina_sig_codigo`, el mismo protocolo que apigateway expone). No hay captura real de un mes con más de 100 recibidas, así que la garantía no es "está probado contra el portal" sino los dos chequeos de integridad de siempre: el conteo tiene que cuadrar con el total que el SII declara y no puede haber folios repetidos. Si el protocolo resultara distinto, la respuesta es `LIMITE_CONOCIDO`, nunca un mes truncado que parezca completo.

El criterio detrás de todas: **es preferible fallar explícito a devolver un dato incompleto que se lea como completo.** Un listado truncado o un año a medias entra al motor contable del consumidor como total real, y nadie vuelve a mirarlo.

---

## 8. Recomendaciones de integración

1. **Ramificá por `ok`, no por el status HTTP.** El status sólo importa para 429 y 401.
2. **Reintentá `ERROR` y nada más**, con backoff. Reintentar `LIMITE_CONOCIDO` o `NO_ENCONTRADO` sólo gasta sesiones del SII.
3. **Serializá las llamadas por RUT.** El SII limita las sesiones simultáneas por contribuyente; paralelizar el mismo RUT provoca fallos que parecen aleatorios.
4. **Distinguí `null` de `0`.** En este contrato `null` significa siempre "el SII no informa esto", nunca cero. Vale para `retencionEmisor`, `totales`, `totalPaginas`, `eventoReceptor` y los folios de un mes sin actividad.
5. **Validá la clave con `/v1/sesion/validar-clave`** antes de guardarla, en vez de descubrir que es inválida en la primera consulta real.
6. **Nunca loguees el header `Authorization`.** El prefijo de la key ya identifica al tenant.
7. **Presupuestá decenas de segundos por llamada**, no milisegundos. Cada una navega el portal del SII.
