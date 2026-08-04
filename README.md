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

## Configuración

Variables de entorno (crear `.env` o configurar en Claude Desktop):

```bash
# RUT de la persona natural autorizada (no el RUT de la empresa)
SII_RUT=12345678

# Opción 1: RUT + Clave de la persona autorizada
SII_CLAVE=mipassword

# Opción 2: Certificado digital (tiene precedencia sobre clave)
SII_CERT_PATH=/ruta/al/certificado.pfx
SII_CERT_PASSWORD=passwordDelCert

# RUT de la empresa a operar (requerido si la persona opera múltiples empresas)
SII_EMPRESA_RUT=22222222
```

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
        "SII_CLAVE": "mipassword",
        "SII_EMPRESA_RUT": "22222222"
      }
    }
  }
}
```

## Tools disponibles

Todas las consultas son de **solo lectura**, con una única excepción marcada como tal.

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
| `sii_cerrar_sesion` | Cierra la sesión en el SII (conviene al terminar) |

Todas requieren **certificado digital**, salvo la emisión de DTE, que corre por navegador
y acepta clave tributaria.

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
