# Emisión de DTE en el portal mipyme: los seis pasos

Fecha: 2026-08-11
Estado: **relevado en vivo y migrado a HTTP.** La previsualización está verificada punta a punta contra el portal real. El paso que emite está implementado pero **todavía no se ejercitó**: no hay ninguna emisión confirmada.

Cierra el pendiente #2 del [contrato del portal mipyme](2026-08-03-mipyme-http-contratos.md),
que dejó `emitirDte` apuntando a `mipeDocAlta.cgi` (404) a propósito, sin
"arreglar" la URL a ciegas.

Empresa de prueba: ASESORÍAS E INVERSIONES TRUFUL SPA, habilitada para facturas.

## El flujo real

Seis pasos, no tres. El plan original suponía tres y el nombre del cuarto CGI
—`mipeGenXMLFirma`— hacía pensar que ahí terminaba.

```
GET  mipeGenFacEx.cgi?PTDC_CODIGO=33        formulario (VIEW_EFXP)
POST mipeDisplayPreView.cgi                 previsualización (PreViewDTE) — no emite
POST mipeGenXMLFirma.cgi                    arma el XML, propone folio, pide firma — NO EMITE
GET  getCertDigital.cgi?rut=&dv=            ¿hay certificado centralizado? → certId
POST postFirmaDigital.cgi                   el SII firma el XML del lado servidor
POST mipeSendXML.cgi                        EMITE
```

`mipeLaunchPage.cgi?OPCION=<tipo>&TIPO=4` se puede saltar: sólo hace un
`location.replace` al formulario.

Notas de crédito: `mipeGenFacEx.cgi?TIPO_PLANTILLA=NC_BLANCO&PTDC_CODIGO=61`
para el caso general, o desde `mipeGesDocEmi.cgi?CODIGO=<n>` los enlaces ya
armados (`IGUAL=CORR_MNT` / `CORR_TXT`, y la anulación que entra **directo a la
previsualización** por GET con `EHDR_CODIGO=<n>&TIPO_NOTA=61`).

## `mipeGenXMLFirma.cgi` no emite, y eso costó un falso positivo

Vale contarlo porque el modo de falla es el que este proyecto viene cerrando: no
hubo ningún error.

Ese POST responde la página *"Firma de Documento Electronico"*, que trae un
`EFXP_FOLIO` con un folio **propuesto** y pide la clave del certificado. La
primera versión del parser buscaba "el primer número después de la palabra
Folio" y devolvió ese valor como si fuera un documento emitido: la herramienta
informó **"emitido, folio 21"** mientras el historial del portal seguía en el
20. Se descubrió recién al verificar el folio contra `mipeAdminDocsEmi.cgi`.

Dos lecciones, las dos fijadas con tests:

1. **Un folio en la respuesta no prueba que el documento exista.** Ahora se
   reconoce la página de firma explícitamente y se falla, en vez de aplicar
   heurísticas sobre el folio.
2. **Verificar el efecto contra otra consulta, no contra la respuesta del propio
   POST.** El historial es la fuente de verdad de que un DTE existe.

El folio propuesto no queda tomado: el SII lo asigna al firmar. Dos intentos que
no llegaron a firmar mostraron folios 21 y 22 sin que el historial pasara del 20.

## La firma: el SII firma, si hay certificado centralizado

El portal ofrece dos modalidades, y sólo una es replicable por HTTP.

- **Certificado local**: un plug-in del navegador firma el XML con el
  certificado instalado en la máquina. No se puede replicar desde un servidor.
- **Certificado centralizado**: el navegador **no firma nada**. Manda la clave y
  el SII firma del lado servidor. Es la que se implementó.

De `pluginsii-1.2.js`:

```
GET  getCertDigital.cgi?rut=&dv=   → [{"nombre":"1", ...}]   certId = nombre
POST postFirmaDigital.cgi          {nombre: certId, dato: <XML>, rut, dv, clave,
                                    nodo: "dte:DTE", nodoId: "dte:Documento",
                                    nameSpace: "http://www.sii.cl/SiiDte"}
                                   → XML firmado
POST mipeSendXML.cgi               el form frmSign completo, con txtSignText = XML firmado
```

Los tres parámetros de nodo son los del caso `OpcionDTE` del plugin, o sea
factura, exenta y nota de crédito. Liquidación (43) y exportación (110-112) usan
otros nodos: una razón más para no emitirlas sin relevarlas.

La clave vive en el entorno (`SII_CERT_CLAVE_SII`) y **no** es un parámetro de
la tool: así el modelo nunca la ve ni puede pedírsela al usuario en un chat.

**No se deriva de `SII_CERT_PASSWORD`.** Hubo una primera versión que caía a esa
variable "porque en la práctica suele ser la misma", y es una suposición que no
se sostiene: el certificado cargado en el SII puede ser otro archivo, o **el
mismo cargado con otra clave** — y ese segundo caso es el traicionero, porque
comparar los certificados diría "coinciden" mientras la clave sigue sin servir.
Derivarla además mandaría la clave del certificado local a
`postFirmaDigital.cgi`, un endpoint que no tiene nada que ver con él, para
terminar fallando igual con un mensaje que apunta al lugar equivocado.

Verificado en la cuenta probada: el certificado centralizado **existe**
(`certId = "1"`).

## El formulario no se puede leer del HTML

El HTML crudo de `mipeGenFacEx.cgi` trae **47 `<input>`; el DOM tiene 67**. Los
`<select>` y varios campos los dibuja JavaScript al cargar. Tres campos
obligatorios llegan con `value=""` y su valor real está sólo en arreglos JS
embebidos:

```js
var emisorDir    = [["DIRECCION","COMUNA","CIUDAD","CODIGO_SUCURSAL"," "], ...];
var emisorActEco = [["702000","ACTIVIDADES DE ..."], ...];
var arrFecha     = ["2026","08","11"];
```

De ahí salen `EFXP_CDG_SII_SUCUR`, `EFXP_ACTECO` y `EFXP_FCH_EMIS`. Se parsean
con regex sobre los literales, sin ejecutar JavaScript. Mandar la fecha vacía
—el primer intento— hace que el CGI rechace el documento.

La previsualización, en cambio, **sí** es parseable del HTML: sus 243 hidden son
el documento completo ya normalizado por el SII, y firmar es reenviarlos
verbatim. Esa asimetría es la que define la arquitectura del scraper.

## Los rechazos vienen dentro de un `alert()`

El CGI responde **200** aunque rechace el documento. Devuelve una página
`<TITLE>Redireccionando</TITLE>` cuyo único contenido útil es:

```js
function redirec() { alert('Debe ingresar el campo : Fecha emision\n'); window.history.go(-1); }
```

O sea que **el motivo del rechazo viaja dentro del JavaScript**. Quedarse con el
título reporta "devolvió Redireccionando", que manda a investigar la sesión
cuando lo que faltaba era un campo. Se extrae el `alert`.

## Obligatoriedad, formatos y el mínimo emisible

De `validaFacEx()`, leída del portal:

| Bloque | Campos obligatorios |
|---|---|
| Emisor | `EFXP_RZN_SOC`, `EFXP_GIRO_EMIS`, `EFXP_ACTECO`, `EFXP_DIR_ORIGEN`, `EFXP_CMNA_ORIGEN`, `EFXP_CIUDAD_ORIGEN`, `EFXP_TIPOVENTA_SELECT`≠0 |
| Receptor | `EFXP_RUT_RECEP`+`EFXP_DV_RECEP` (módulo 11), `EFXP_RZN_SOC_RECEP`, `EFXP_GIRO_RECEP`, `EFXP_DIR_RECEP`, `EFXP_CMNA_RECEP`, `EFXP_CIUDAD_RECEP`, `EFXP_TIPOCOMPRA_SELECT`≠0 |
| Detalle | `EFXP_NMB_01` (máx **25**), `EFXP_QTY_01`≥1, `EFXP_PRC_01`≥0 |
| Pago | `EFXP_FMA_PAGO`≠0 — 1 contado, 2 crédito (default), 3 sin costo |
| Totales | `EFXP_MNT_TOTAL`≥1 y, en tipo 33, **`EFXP_IVA`≥1** |

`EFXP_CIUDAD_ORIGEN` es obligatorio y el portal lo entrega **vacío**.

Los totales los calcula el JavaScript y **viajan en el POST**: el CGI los recibe,
no los recalcula. `IVA = round(neto × 0,19)`, medido en vivo:

| neto | 1 | 2 | 3 | 4 | 10 |
|---|---|---|---|---|---|
| IVA | 0 | 0 | 1 | 1 | 2 |
| total | 1 | 2 | **4** | 5 | 12 |

**El neto mínimo emisible en una factura afecta es 3.** Con 1 o 2 el IVA da 0 y
el portal rechaza con "Valor IVA debe ser mayor a 0" — que es por qué una prueba
de $1 no se puede hacer.

Referencias (hasta 3, la primera obligatoria si `REF_SI_NO`): `EFXP_TPO_DOC_REF_00n`,
`EFXP_FOLIO_REF_00n` (>0), `EFXP_FCH_REF_00n` (`AAAA-MM-DD`, entre 2002-08-01 y
2050-12-31), `EFXP_RAZON_REF_00n` (≤90), `EFXP_IND_GLOBAL_00n` (sólo `1`, y
entonces folio 0) y, en nota de crédito, `EFXP_CODIGO_REF_00n`: **1 anula, 2
corrige texto, 3 corrige montos**.

## Codificación: ISO-8859-1 y entidades numéricas

Dos trampas que no dan error, sólo un documento tributario con el nombre del
contribuyente roto:

1. El POST debe ir en **ISO-8859-1**. `encodeURIComponent` percent-encodea en
   UTF-8 y la `Í` de "ASESORÍAS" viajaría como `%C3%8D`, que el CGI lee como dos
   caracteres.
2. El portal escapa con entidades **numéricas** (`&#205;` por la Í, `&#64;` por
   la arroba), no sólo con las nombradas que el proyecto ya traducía. Reenviarlas
   sin decodificar emite el DTE con `&#205;` literal.

El contenido de los `<textarea>` es la excepción: es el XML que el SII va a
firmar, y decodificar sus entidades rompería la firma.

## Lo que falta

1. **Ejercitar la emisión.** El camino está implementado y sin usar: no hay
   ninguna emisión confirmada, así que la respuesta de `mipeSendXML.cgi` no está
   relevada y el criterio de éxito está fijado por analogía con los otros pasos
   (falla ante un `alert` o si vuelve a pedir la firma).
2. **Configurar `SII_CERT_CLAVE_SII`.** Es la única variable nueva que exige la
   emisión, y hoy no está puesta: no se puede emitir sin ella. No hay forma de
   derivarla ni de verificarla contra el `.p12` local (ver arriba).
3. Guía (52), factura de compra (46), liquidación (43) y exportación (110-112):
   sin relevar. La tool los rechaza explícito.
4. El detalle de líneas de un documento emitido, que sigue sin estar en
   `mipeGesDocEmi.cgi`.
