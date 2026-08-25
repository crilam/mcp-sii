# Endpoint de situación tributaria de terceros — Diseño

> Autor: sesión Tributy (integración). Destinatario: mantenedores de mcp-sii.
> Fecha: 2026-08-21.

## Contexto y decisión

El usuario decidió **centralizar todo el acceso al SII a través de mcp-sii**.
Hoy Tributy consulta la "situación tributaria de terceros" (razón social,
inicio de actividades, actividades económicas, documentos timbrados) contra
**apigateway.cl**, un gateway de terceros con **tope de 500 consultas/día**.
Para no gastar ese cupo y unificar el acceso SII, esta consulta debe pasar a
mcp-sii como un endpoint nuevo.

## Lo que hace especial a este endpoint

A diferencia de TODAS las rutas REST actuales de mcp-sii (`/v1/rcv/*`,
`/v1/bhe/*`, `/v1/renta/*`, `/v1/dte/*`, `/v1/persona/bienes-raices`,
`/v1/mipyme/*`), esta:

- **No requiere `clave`.** Es una consulta pública de terceros: cualquiera
  puede consultar la situación de cualquier RUT sin autenticarse ante el SII.
- **No requiere navegador (`agent-browser`).** Son dos POST HTTP planos contra
  `zeus.sii.cl`. Saltea por completo `SessionManager`, `Browser`,
  `RegistroSesiones` y `ProveedorCredencialesRuntime`. Es un cliente HTTP
  simple (`fetch`/`curl`), mucho más liviano que el resto de los dominios.
- Por lo mismo **no serializa por RUT** ni consume una sesión: es reentrante.

Sigue usando el **auth de tenant** (Bearer API key) y el **rate-limit por
tenant** como el resto del adaptador REST.

## Contrato del endpoint

### `POST /v1/contribuyente/situacion-tributaria`

**Body:**
```json
{ "rut": "76632059-7" }
```
(sin `clave`)

**Respuesta éxito (200):** misma forma que Tributy ya normaliza en
`src/apigateway/contribuyentes.ts` (tipo `SituacionTributaria`), para que el
cableado del lado Tributy sea trivial:
```json
{
  "rut": "76632059-7",
  "razonSocial": "INFOSEC SERVICIOS DE SEGURIDAD INFORMATICA SPA",
  "inicioActividades": true,
  "fechaInicioActividades": "08-07-2016",
  "proPyme": true,
  "monedaExtranjera": false,
  "actividades": [
    { "codigo": 262000, "giro": "FABRICACION DE COMPUTADORES...", "categoria": 1, "afectaIva": true }
  ],
  "observaciones": []
}
```

**Errores:**
- `400 { error: "RUT_INVALIDO" }` — RUT mal formado o DV inválido.
- `404 { error: "NO_ENCONTRADO" }` — el SII no devuelve datos para ese RUT.
- `502 { error: "FUENTE_NO_DISPONIBLE" }` — zeus.sii.cl caído o HTML inesperado.
- `401/429` de tenant igual que el resto.

## Mecanismo real contra el SII (2 requests, sin login)

La página pública `https://www2.sii.cl/stc/noauthz` es una SPA; el mecanismo
real es el CGI `getstc` de `zeus.sii.cl`. El "captcha" **no requiere OCR**: el
endpoint de captcha devuelve un blob cuya respuesta está incrustada.

### 1. Obtener captcha
```
POST https://zeus.sii.cl/cvc_cgi/stc/CViewCaptcha.cgi
Content-Type: application/x-www-form-urlencoded
Body: oper=0
→ 200 JSON { "txtCaptcha": "<base64>" }
```
El código de 4 caracteres se extrae del propio blob:
```
code = base64decode(txtCaptcha).slice(36, 40)   # 4 bytes ASCII
```

### 2. Consultar situación
```
POST https://zeus.sii.cl/cvc_cgi/stc/getstc
Content-Type: application/x-www-form-urlencoded
Body: RUT=<cuerpo sin DV>&DV=<dv>&PRG=STC&OPC=NOR&txt_code=<code>&txt_captcha=<txtCaptcha>
→ 200 HTML (NO json)
```

### Parseo del HTML (xpaths verificados)
Fuente: `github.com/pdelteil/sii_situacion_tributaria` (`consulta.py`), réplica
exacta de lo que hace apigateway.

- `razon_social`: `/html/body/div/div[4]` (text)
- `actividades`: filas de `/html/body/div/table[1]/tr` salteando la header;
  por fila: `td[1]/font`=giro, `td[2]/font`=codigo (int), `td[3]/font`=categoria,
  `td[4]/font`=afecta (texto `"Si"` → true)
- `inicio_actividades`: `span` que contiene
  `"Contribuyente presenta Inicio de Actividades:"`
- `fecha_inicio_actividades`: `span` `"Fecha de Inicio de Actividades:"`
- `empresa_menor_tamano` (→ `proPyme`): `span`
  `"Contribuyente es Empresa de Menor Tama..."`
- `aut_moneda_extranjera` (→ `monedaExtranjera`): `span`
  `"...declarar y pagar sus impuestos en moneda extranjera:"`
- `documentos_timbrados`: la tabla `class="tabla"` que sigue al `<strong>` con
  texto `"Documentos Timbrados"`.
  **Trampa real:** la página tiene varias tablas `class="tabla"`; anclar al
  `<strong>` correcto. Un `//table[@class='tabla']/tr` genérico mezcla filas de
  la tabla de "autorización no electrónica" y entran rangos de fecha como
  documentos basura (ej. `{"Documento": "01-02-2017"}`).

## Normalización (reusar la lógica que Tributy ya tiene)

`src/apigateway/contribuyentes.ts` de Tributy ya normaliza esta respuesta:
booleanos desde `"Si"/"No"`, RUT a forma canónica (dígitos + DV minúscula, sin
puntos ni guion), actividades laxas. Conviene replicar esa normalización del
lado mcp-sii para devolver la forma de arriba. Puedo pasar ese archivo como
referencia si ayuda.

## Trampas / cuidados

- **Verificar que el RUT devuelto coincide con el pedido.** El portal a veces
  puede devolver otro contribuyente; atribuir a un socio la razón social de un
  tercero es peor que no tener el dato. Descartar y devolver `NO_ENCONTRADO`.
- **Cachear por RUT.** La situación tributaria casi no cambia; cachear (TTL
  largo, p.ej. 24h) reduce carga y latencia.
- **Rate-limit cortés hacia `zeus.sii.cl`.** No hay tope tipo apigateway, pero
  no conviene martillar.
- **HTML frágil.** Si el SII cambia el layout, rompe. Testear con un fixture de
  HTML real de `getstc` (como ya hacen otros dominios con fixtures).
- **El truco del captcha** lleva años estable, pero si el SII lo cambia habría
  que resolver captcha real. Documentar el supuesto.

## Wiring del lado Tributy (fuera de alcance de este spec)

Una vez deployado, Tributy cablea el autocompletado de datos de nodo
(`CamposNodo`) a este endpoint y retira la dependencia de apigateway para esta
consulta. Necesito de vuelta: ruta, body y forma de respuesta finales.
