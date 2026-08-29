# Ronda 8 — `misii`: relevamiento de la ficha del contribuyente

> Fase 0 de la ronda 8. Relevado en vivo el 2026-08-29 contra una empresa real
> (persona jurídica comercial, S.A. cerrada). Todos los valores de ejemplo de
> este documento están **anonimizados**: los datos reales no se versionan.

## El hallazgo que cambia el diseño

**El home de Mi SII no hay que scrapearlo: sirve JSON.**

`https://misiir.sii.cl/cgi_misii/siihome.cgi` devuelve una página de ~50 KB que
embebe **tres payloads JSON completos** como variables JavaScript, ya
serializados por el servidor:

| Variable | Contenido |
|---|---|
| `DatosCntrNow` | `{contribuyente, direcciones[], atributos[], alertas[]}` |
| `DatosActeco` | array de actividades económicas vigentes |
| `DatosCntrAler` | `{alertas[]}` |

Esto importa más que la comodidad. Todo el resto del portal legacy se parsea con
regex sobre rótulos de HTML, que es el modo de falla más caro que tiene este
repositorio: un cambio de maquetado devuelve datos plausibles y equivocados sin
fallar. Acá el contrato es un JSON con nombres de campo estables, y el parseo se
reduce a `JSON.parse` sobre una asignación delimitada por llaves balanceadas.

**Riesgo real, y es otro:** que el SII renombre la variable o cambie de esta
técnica a XHR. Eso falla RUIDOSAMENTE (no se encuentra la variable), que es
exactamente lo que se quiere. La regla de implementación es no aceptar una
ausencia como "sin datos": si `DatosCntrNow` no aparece, es error, no vacío.

## Inventario de campos

### `contribuyente` — 45 campos

Los que le sirven a una ficha de empresa:

| Campo | Ejemplo (anonimizado) |
|---|---|
| `rut` + `dv` | `"22222222"` + `"2"` |
| `razonSocial` | `"EMPRESA DE EJEMPLO S.A."` |
| `tipoContribuyenteCodigo` / `tipoContribuyenteDescripcion` | `"2"` / `"PERSONA JURIDICA COMERCIAL"` |
| `subtipoContribuyenteCodigo` / `subtipoContribuyenteDescrip` | `"213"` / `"SOCIEDADES ANONIMAS CERRADAS"` |
| `fechaConstitucion` | `"2008-03-26 00:00:00.0"` |
| `fechaInicioActividades` | `"2008-05-26 00:00:00.0"` |
| `fechaTerminoGiro` | `null` |
| `eMail`, `telefonoMovil` | contacto registrado |
| `segmentoCodigo` / `segmentoDescripcion` | `"SGME"` / `"MEDIANA EMPRESA"` |
| `personaEmpresa` | `"EMPRESA"` |
| `glosaActividad` | glosa libre de la actividad |
| `capitalEnterado` / `capitalPorEnterar` | `"5000"` / `"0"` |
| `unidadOperativaCodigo` / `Descripcion` / `Direccion` | la unidad del SII que le corresponde |
| `autorizadoDeclararDia20` | `"S"` |
| `declaraTG` | `"No"` |

Ojo con dos convenciones del payload: las fechas vienen en **dos formatos
distintos** —`"2008-05-26 00:00:00.0"` en `contribuyente`, `"01-01-2026"`
(dd-mm-aaaa) en `atributos`— y los booleanos son strings `"S"`/`"N"` o
`"No"`. Normalizar en el borde, no propagar.

### `atributos[]` — la respuesta al régimen tributario

**Sí: el régimen vigente viene parseable y con fecha de vigencia.** Es la
pregunta que bloqueaba el modelo de AgenticERP.

Forma: `{rut, dv, atrCodigo, descAtrCodigo, fechaInicio, fechaTermino, valor, ...}`.
Diez atributos en la empresa relevada:

| `atrCodigo` | `descAtrCodigo` | `fechaInicio` | `valor` |
|---|---|---|---|
| `14D1` | REGIMEN PRO PYME GENERAL (14D) | 01-01-2026 | `"Inscripción Internet"` |
| `CPYM` | CONTABILIDAD REGIMEN TRIBUTARIO PYME | 01-01-2026 | `"COMPLETA"` |
| `EMTP` | EMPRESA DE MENOR TAMANO | 01-01-2024 | `"MEDIANA"` |
| `SGME` | MEDIANA EMPRESA | 01-01-2026 | `"15.000<=Ingresos <60.000 UTM"` |
| `FAEL` | FACTURADOR ELECTRONICO | 15-07-2016 | folio + fecha |
| `OFE2` | OBLIGADO A FACTURACION ELECTRONICA ETAPA 2 | 01-08-2016 | `"."` |
| `BOLE` | USUARIO BOLETA ELECTRÓNICA MERCADO | 01-08-2022 | `"S"` |
| `INTE` | CONTRIBUYENTE EMITE SIEMPRE BOLETA Y VOUCHER | 15-10-2021 | `"."` |
| `NOTI` | CONTRIBUYENTE ES NOTIFICADO POR CORREO ELECTRONICO | 07-04-2026 | correo |
| `PCOV` | POSTERGACION PAGO IVA EN 6 O 12 CUOTAS COVID-19 | 30-03-2020 | `"12"` |

`fechaTermino: null` significa vigente. **El régimen es el atributo cuyo
`atrCodigo` empieza con `14`** (acá `14D1`); la lista completa de códigos de
régimen no se relevó —esta empresa tiene uno solo—, así que un mapeo a enum
debe tratar el código desconocido como "no reconocido", nunca caer a un default.

Los atributos son una **lista abierta**: aparecen y desaparecen con el tiempo
(`PCOV` es de la pandemia). Modelarlos como bolsa con código, glosa, vigencia y
valor, no como campos fijos.

### `direcciones[]` — 33 campos

`codigo`, `tipoDomicilioCodigo`/`Descripcion`, `calle`, `numero`, `bloque`,
`departamento`, `villaPoblacion`, `ciudad`, `comunaCodigo`/`comunaDescripcion`,
`regionCodigo`/`regionDescripcion`, `manzana`, `predio`, `tipoPropiedadCodigo`/
`Descripcion`, `rutPropietario`/`dvPropietario`, `canon`, `telefono`, `fax`,
`codigoPostal`, `casilla`, `correo`, `mail`, `fuente`, `fechaModiRegistro`.

La empresa relevada tiene **una sola** dirección, así que el comportamiento con
sucursales múltiples **no está verificado**. El array admite varias y la tabla
del portal tiene columna "Código Sucursal", pero eso es inferencia, no
evidencia.

### `DatosActeco[]` — actividades económicas

`{codigo, descripcion, categoriaTributaria, afectoIva, fechaInicio}`. Cuatro
filas en la empresa relevada. Ejemplo: `codigo: "522120"`, `categoriaTributaria:
"1"`, `afectoIva: "S"`, `fechaInicio: "16-12-2015"`.

Es **más rico que lo que ya expone** `/v1/contribuyente/situacion-tributaria`:
agrega `fechaInicio` por actividad, que el informe público no trae.

## Segunda empresa: qué cerró y qué no

Se relevó una segunda empresa (persona jurídica comercial, **sociedad por
acciones**, distinta de la primera que es S.A. cerrada) para contrastar. Misma
estructura de payloads, y:

- **El régimen se confirma como mecanismo.** También `14D1` (REGIMEN PRO PYME
  GENERAL), pero con `fechaInicio` distinta: 13-03-2025 contra 01-01-2026 de la
  primera. La fecha es del contribuyente, no una constante del código.
- **Los atributos son efectivamente una lista abierta.** Comparten cuatro
  códigos (`14D1`, `CPYM`, `EMTP`, `NOTI`) y difieren en el resto: la primera
  trae `BOLE, FAEL, INTE, OFE2, PCOV, SGME` y la segunda `BSII, FPYM, REGS,
  SGPM`. Diez y ocho atributos respectivamente. Modelar columnas fijas habría
  fallado con la segunda empresa.
- **`subtipoContribuyenteDescrip` varía** (SOCIEDADES ANONIMAS CERRADAS contra
  SOCIEDAD POR ACCIONES), así que es dato del contribuyente y no una constante
  del tipo.

**Representantes legales y socios: el portal no los entrega acá.** Las dos
empresas —una S.A. y una SpA, las dos con representante legal registrado ante el
SII por obligación— muestran "No registra información" en las cuatro tablas. No
aparecen en ningún JSON, y se revisó `misii.min.js` y
`funciones_misii_footer.min.js` sin encontrar ninguna llamada que llene esos
contenedores (`divRepress`, `represOld`, `divSociosNew`, `divSociosOld`): el
único `.cgi` que mencionan es `siihome.cgi`.

Con dos contribuyentes de forma jurídica distinta dando lo mismo, la lectura ya
no es "esta empresa no los tiene": **la sección está en la página pero servida
vacía**. Sacarlos requiere otra fuente y su propio relevamiento. Candidato a
mirar, con una advertencia: `zeusr.sii.cl/cgi_AUT2000/admRPTEBuild.cgi`
("Administrar representantes electrónicos") es **representación electrónica**,
que NO es lo mismo que el representante legal societario. No confundirlos al
implementar.

## Lo que sigue sin verificar

- **Sucursales múltiples.** Las dos empresas tienen una sola dirección. El array
  admite varias y la tabla del portal tiene columna "Código Sucursal", pero eso
  es inferencia, no evidencia.
- **Códigos de régimen distintos de `14D1`.** Las dos empresas están en el mismo
  régimen. El mapeo de cualquier otro código sigue sin evidencia.

## Las otras tres páginas candidatas: descartadas

Relevadas en la misma sesión, ninguna sirve:

| Página | Resultado |
|---|---|
| `misiir.sii.cl/cgi_misii/siicont.cgi` | **9 bytes**. No es un endpoint vivo. |
| `www4.sii.cl/regimenesTributariosInternet/` | 700 bytes: el shell de una SPA. Los datos saldrían del bundle, y ya no hacen falta: el régimen está en `atributos`. |
| `zeus.sii.cl/cvc/vdc/index.html` (timbraje) | 6 KB de landing sin datos. El timbraje necesita su propio relevamiento. |

## Contrato propuesto

`POST /v1/misii/ficha-contribuyente`, body `{rut, clave}` (o certificado; desde
el PR #55 las dos credenciales sirven en todas las consultas).

Una sola llamada, una sola sesión del SII, tres payloads. Respuesta en dos
capas:

```jsonc
{
  "capturadoEn": "2026-08-29T04:12:33.000Z",  // cuándo se leyó DEL SII, no cuándo se respondió
  "parserVersion": 1,
  "rut": "22222222-2",                        // el del payload del SII, para verificar identidad
  "razonSocial": "EMPRESA DE EJEMPLO S.A.",
  "tipoContribuyente": { "codigo": "2", "descripcion": "PERSONA JURIDICA COMERCIAL" },
  "subtipoContribuyente": { "codigo": "213", "descripcion": "SOCIEDADES ANONIMAS CERRADAS" },
  "fechaConstitucion": "2008-03-26",
  "fechaInicioActividades": "2008-05-26",
  "fechaTerminoGiro": null,
  "segmento": { "codigo": "SGME", "descripcion": "MEDIANA EMPRESA" },
  "regimen": {                          // derivado de atributos[] con atrCodigo 14*
    "codigo": "14D1",
    "descripcion": "REGIMEN PRO PYME GENERAL (14D)",
    "desde": "2026-01-01",
    "hasta": null
  },
  "actividades": [
    { "codigo": 522120, "giro": "…", "categoria": 1, "afectaIva": true, "desde": "2015-12-16" }
  ],
  "direcciones": [ { "tipo": "…", "calle": "…", "numero": "…", "comuna": "…", "region": "…" } ],
  "atributos": [ { "codigo": "…", "descripcion": "…", "desde": "…", "hasta": null, "valor": "…" } ],
  "crudo": { "version": 1, "contribuyente": {}, "direcciones": [], "atributos": [], "actividades": [] }
}
```

- **Núcleo tipado** para lo que la contabilidad consume, con fechas
  normalizadas a ISO y booleanos reales.
- **`crudo` versionado** con los payloads tal cual: el día que el SII agregue un
  campo, el consumidor lo tiene sin esperar un release nuestro.
- **`regimen` es derivado, y su derivación es la parte frágil.** Si ningún
  atributo matchea, va `null` con el motivo — nunca un default.

Caché por RUT del orden de horas: esta ficha cambia con frecuencia de meses y
cada consulta abre una sesión real.

### Procedencia, y por qué la fecha no puede ser la del request

Tres campos que pidió el consumidor (AgenticERP) y que conviene fijar en el
contrato, porque los tres nacen de un error posible:

- **`capturadoEn` es la hora en que se leyó del SII, no la del response.** Con
  caché de horas, fechar con la hora de la respuesta afirma una confirmación
  contra el SII que no ocurrió en ese momento — y esa fecha es la que la ficha
  le muestra al usuario final. Un acierto de caché devuelve el `capturadoEn`
  original, no `now()`.
- **`parserVersion`** viaja con cada captura, para poder auditar hacia atrás qué
  parseo produjo un dato que después resultó estar mal.
- **`rut` dentro del payload** viene del JSON del SII, no del request. Permite
  al consumidor verificar identidad antes de escribir: una sesión cruzada
  escribiría la identidad de otro contribuyente en silencio.

### Quién normaliza: nosotros

Las fechas salen ISO (`"2008-05-26"`) y los booleanos convertidos, en el núcleo
tipado. El payload original queda intacto bajo `crudo`, con sus dos formatos de
fecha y sus `"S"`/`"N"`/`"No"`, para quien necesite auditar.

Que lo haga el adaptador y no cada consumidor es lo correcto acá: la
irregularidad es del SII, es conocida, y replicar su normalización en cada
cliente multiplica el mismo bug. `crudo` deja abierta la salida de emergencia si
alguna vez normalizamos mal.

## Criterio de terminado

1. Parser sobre las tres variables, con fallo ruidoso si alguna falta.
2. Ruta REST + tool MCP a la par.
3. Fixture anonimizado, y verificado que los tests fallan si se rompe lo que
   dicen proteger.
4. Segunda empresa relevada para cerrar representantes, socios y sucursales, o
   se documentan como limitación conocida.
