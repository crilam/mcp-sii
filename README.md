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
| `sii_renta_get_f22` | Formulario 22 completo de un año tributario |
| `sii_renta_estado_declaracion` | Estado de la declaración de renta |

### Boletas de honorarios y persona natural

| Tool | Descripción |
|---|---|
| `sii_bhe_list_emitidas` | Boletas de honorarios emitidas |
| `sii_bhe_list_recibidas` | Boletas de honorarios recibidas |
| `sii_bhe_resumen` | Resumen anual de boletas |
| `sii_persona_list_bienes_raices` | Bienes raíces de la persona |

`sii_persona_list_bienes_raices` funciona hoy con la sesión que abre
`sii_iniciar_sesion` (clave, por navegador). Las demás de esta sección y las
de las secciones anteriores (Consultas DTE, Impuestos y registros, y las dos
tools de listado de mipyme) consultan por HTTP y hoy necesitan certificado
digital para tener el cookie jar que esa vía requiere — ver la limitación
anotada en
[Autenticación: sesión por RUT](#autenticación-sesión-por-rut).
`sii_mipyme_emitir_dte` sigue corriendo por navegador y acepta clave.

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

## Desarrollo

```bash
npm test          # correr tests
npm run dev       # desarrollo con ts-node
npm run build     # compilar TypeScript
```
