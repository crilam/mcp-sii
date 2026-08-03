# Portal mipyme por HTTP: contratos del CGI legacy

Fecha: 2026-08-03
Estado: **listado de empresas, historial de emitidos, filtros, paginación y detalle verificados en vivo por HTTP.** La emisión no se ejercitó — y el relevamiento encontró que la ruta que usa el código hoy no existe.

Spike previa a migrar `sii_mipyme_*` del navegador a HTTP directo. Continúa el [spike de Consultas DTE](2026-08-03-migrar-navegador-a-http.md) y responde el pendiente principal del [mapa de estado](2026-08-03-estado-y-pendientes.md).

Todo lo de acá se ejercitó **sólo con GET**, salvo el POST de selección de empresa, que fija estado de sesión y no tiene efecto tributario. **No se emitió, anuló ni modificó ningún documento.**

## El alcance real es mucho menor de lo que decía el inventario

El mapa de estado estimaba la deuda de navegador de mipyme en ~70 llamadas. **Cuatro de los siete métodos públicos de `MipymeScraper` son código muerto.**

`listDocumentosEmitidos`, `getDocumentoEmitido`, `listDocumentosRecibidos` y `getDocumentoRecibido` apuntan a `consemitidosinternetui` — **la misma aplicación que #21 ya migró a HTTP** en `DteScraper`. Ninguna tool los llama: `registerMipymeTools` sólo expone `listEmpresas`, `listMipymeDteEmitidos` y `emitirDte`. Quedaron vivos únicamente por sus tests.

Consecuencia: la migración de mipyme son **tres flujos sobre CGI legacy** (`www1.sii.cl/cgi-bin/Portal001`), más un borrado. El CGI legacy es el mismo terreno que las boletas de honorarios ya recorren por HTTP, así que el transporte existe.

| Flujo | Estado tras esta spike |
|---|---|
| `listEmpresas` | **contrato resuelto** |
| `listMipymeDteEmitidos` | **contrato resuelto**, incluidos filtros y paginación |
| `emitirDte` | ruta del portal identificada; **el código actual apunta a una URL que da 404** |
| Los cuatro métodos de `consemitidos` | **borrar**, con sus tests |

## Selección de empresa

```
GET  https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi
POST https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi   RUT_EMP=<RUT-DV>
```

El GET autenticado devuelve la página real (`<title>Facturacion Electrónica MIPYME - Seleccion de Empresa</title>`), con un `<select name="RUT_EMP">` y una `<option value="RUT-DV">` por empresa. **El valor es el RUT con dígito verificador**, y el texto de la opción trae el nombre. No hay campos ocultos: el POST lleva `RUT_EMP` y nada más.

En la cuenta probada el combo trae **5 empresas** — el mismo número que ya estaba documentado para mipyme, contra 17 en el RCV y en Consultas DTE. Sigue vigente que cada aplicación tiene su propia lista.

Esto reemplaza el navegador entero para `sii_mipyme_list_empresas`: es un GET y un parseo de `<option>`.

## La empresa seleccionada vive en el servidor, no en una cookie

Es el hallazgo con más consecuencias de diseño, y contradice lo que se esperaba.

Se comparó el cookie jar **antes y después** del POST de selección, con una empresa distinta a la de la sesión:

```
cookies que cambiaron con la selección: []
cookies nuevas: []
```

`NETSCAPE_LIVEWIRE.rutm` sigue siendo el RUT de la **persona**, no el de la empresa elegida. O sea: la empresa activa es **estado del lado del servidor**, atado a `CSESSIONID`, y no viaja en ningún parámetro ni cookie que podamos inspeccionar.

Consecuencias, y hay que tomarlas las tres juntas:

1. **Migrar mipyme a HTTP no lo vuelve multi-empresa por sí solo.** A diferencia de Consultas DTE, donde la empresa es parámetro de cada consulta, acá sigue habiendo una empresa activa por sesión.
2. **El candado sigue siendo necesario.** `conEmpresaExclusiva` no es una limitación del navegador: dos consultas con `empresa_rut` distinto intercaladas sobre la misma sesión se pisan igual por HTTP —A selecciona, B selecciona, A lee— y A devuelve datos de la empresa de B como correctos. Migrar sin conservar la serialización reabre ese fallo silencioso.
3. **Lo que sí compra HTTP es que la sesión pase a ser un objeto por identidad** (un cookie jar por credencial) en vez de un Chrome único con un almacén global. Con [una credencial por empresa](2026-08-03-estado-y-pendientes.md) cada empresa tiene su sesión, y la selección deja de ser un cambio de estado compartido: es el paso inicial de *su* sesión.

Que la empresa sea estado de servidor no bloquea el aislamiento; sólo dice que el aislamiento lo da la sesión por identidad, no el parámetro por consulta.

El POST responde una página mínima (681 bytes) cuyo único contenido es un `redirec_intra()` que hace `window.location.replace('/factura_sii/factura_sii.htm')`. Por HTTP eso no hay que seguirlo: basta con que el POST haya ocurrido.

## Consultar sin haber seleccionado empresa falla explícito

```
GET .../mipeAdminDocsEmi.cgi          (sin POST de selección previo)
→ <title>Error al contribuyente</title>
   "...no ha seleccionado una Empresa."
   CODIGO: 02.35.209.-1.148.10
```

Es un fallo limpio y reconocible, no un vacío. Vale mapearlo por lo que es —falta el paso de selección— en vez de dejar que se lea como "esta empresa no tiene documentos".

## Historial de DTE emitidos

```
GET .../mipeAdminDocsEmi.cgi?RUT_RECP=&FOLIO=&RZN_SOC=&FEC_DESDE=&FEC_HASTA=&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1
```

Los parámetros que ya arma `buildHistorialUrl` son correctos y funcionan por HTTP tal cual. Verificado:

- **`TPO_DOC` filtra de verdad.** Con `33` las 100 filas de la página son `Factura Electronica`; sin filtro, la misma página trae 94 facturas, 6 notas de crédito.
- **`NUM_PAG` pagina de verdad.** Página 1 trae 100 filas, página 2 trae 84, y son documentos distintos. El HTML dice "Página 1 de 3".
- **Con filtros vacíos devuelve el histórico completo**, no el período actual: en la empresa probada, documentos desde 2018.
- Las fechas van y vuelven como **`AAAA-MM-DD`**, y los montos **sin separador de miles**. El parser del navegador esperaba `dd/mm/yyyy` y montos con puntos: es la representación de la tabla renderizada, no la del HTML. **No reusar ese parser.**

### El `<td>` sin cerrar, y por qué importa

La fila del historial trae HTML malformado: la celda del RUT del receptor **no cierra**.

```html
<tr> <td> <a href="...mipeGesDocEmi.cgi?ALL_PAGE_ANT=2&CODIGO=..."><img ...></a></td>
     <td>77777777-7<td>RAZON SOCIAL</td> <td>Factura Electronica</td>
     <td>244</td> <td>2022-07-08</td> <td>24783</td> <td>Documento Emitido</td> </tr>
```

El header declara 8 columnas: `Ver | Receptor | Razón Social | Documento | Folio | Fecha | Monto | Estado`.

Un parser que exija `</td>` **devuelve 7 celdas y pierde el RUT**, corriendo todo un lugar:

| Parser | Resultado |
|---|---|
| Con cierre estricto (`<td>…</td>`) | `["", "RAZON SOCIAL", "Factura Electronica", "244", …]` |
| Cortando en `</td>` **o** en el `<td` siguiente | `["", "77777777-7", "RAZON SOCIAL", "Factura Electronica", "244", …]` |

El modo de falla es el peor de los que este proyecto viene cerrando: no hay error, y el campo `receptorRut` sale poblado con la razón social. **Un test tiene que fijar las 8 columnas contra una fixture que conserve el `<td>` sin cerrar**, o el bug vuelve en la primera refactorización del parser.

### Detalle de un documento

```
GET .../mipeGesDocEmi.cgi?ALL_PAGE_ANT=<n>&CODIGO=<identificador>
```

El link de cada fila lo trae armado, y hay que tomarlo de ahí: `CODIGO` es un identificador interno del documento, **no el folio**, y no se puede construir desde los datos de la fila.

La página que devuelve (7 KB) no es un detalle de líneas: es un menú de acciones sobre el documento — *Seguimiento*, *Reparos*, y ***Generar Nota de Débito de Anulación***. Dos consecuencias:

1. Si se quiere el detalle de líneas del documento, **está en otra pantalla y no se relevó**. `getDocumentoEmitido` del camino viejo devolvía `lineas: []` de todos modos.
2. **Desde acá se llega a un acto de escritura con consecuencias tributarias.** Cualquier tool que exponga este detalle no debe seguir esos enlaces, y conviene decirlo en su descripción como ya se hizo con la emisión de boletas.

## Emisión: la ruta del código actual no existe

`MipymeScraper.emitirDte` abre `mipeDocAlta.cgi?TPO_DOC=<tipo>`. Por HTTP autenticado:

```
GET .../mipeDocAlta.cgi?TPO_DOC=33  →  Error 404
```

El portal de facturación (`/factura_sii/factura_sii.htm`, al que redirige la selección de empresa) enlaza la emisión así:

```
/cgi-bin/Portal001/mipeLaunchPage.cgi?OPCION=<tipoDte>&TIPO=4
```

Con `OPCION` = 33, 34, 52, 46, 43, 110 — el tipo de DTE — más variantes por query string (`esCRED_EC`, `esFACT_TUR`). Las notas de crédito y débito entran por páginas propias (`/Portal001/EmiNotaCredito.html`).

Dos lecturas posibles, y **no se puede elegir entre ellas sin probar**: que `mipeDocAlta.cgi` exista sólo para el navegador (poco probable: es un CGI, no una ruta de SPA), o que **`sii_mipyme_emitir_dte` esté roto hoy** y nadie lo haya notado porque emitir de prueba tiene costo real. La segunda es la hipótesis fuerte.

No se ejercitó `mipeLaunchPage.cgi` en esta spike para no acumular sesiones abiertas, y sobre todo porque el flujo de emisión hay que recorrerlo con el mismo criterio que las boletas de honorarios: los pasos de lectura y previsualización sí, el paso que emite no.

## Lo que falta

1. **Confirmar el estado de `sii_mipyme_emitir_dte`.** Es lectura pura: un GET a `mipeLaunchPage.cgi?OPCION=33&TIPO=4` dice si la ruta vive y qué formulario sirve. Si el código apunta a un 404, la tool está rota y hay que decirlo antes que migrarla.
2. **El formulario de emisión**: campos, obligatoriedad, formato, y si hay un paso de previsualización como en las boletas. Sin eso, migrar `emitirDte` sería reescribir a ciegas un camino que además emite.
3. **El detalle de líneas de un documento emitido**, si se lo quiere: no está en `mipeGesDocEmi.cgi`.
4. **Qué devuelve el historial cuando la empresa no tiene documentos.** El código actual espera el texto "No existen documentos"; no se pudo verificar porque la empresa probada tiene 184.
5. **Los valores de `ESTADO` y `ORDEN`**, que se mandan vacíos y funcionan, pero cuyo dominio no se relevó.

## Orden recomendado para implementar

1. **Borrar los cuatro métodos muertos de `MipymeScraper` y sus tests.** Reduce el archivo a la mitad antes de tocar nada, y elimina la ilusión de que hay dos caminos para las mismas consultas.
2. **`listEmpresas` por HTTP**: GET, parseo de `<option>`. Es el cambio más chico y el que más navegador saca.
3. **`listMipymeDteEmitidos` por HTTP**, con el parser tolerante al `<td>` sin cerrar, fixture anonimizada que conserve la malformación, y el mapeo de "no ha seleccionado una Empresa" como error propio.
4. **Recién entonces la emisión**, empezando por el punto 1 de "lo que falta" — que es lectura y puede cambiar el diagnóstico.

Conservar en los cuatro pasos: el POST de selección antes de cada consulta y la serialización de `conEmpresaExclusiva`. La empresa sigue siendo estado de sesión del servidor, así que el candado no es una herencia del navegador — es un requisito del CGI.
