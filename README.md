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

| Tool | Descripción | Auth requerida |
|---|---|---|
| `sii_list_empresas` | Lista empresas disponibles para la persona autenticada | Certificado |
| `sii_list_documentos_emitidos` | Lista DTEs emitidos con filtros opcionales | Certificado |
| `sii_get_documento_emitido` | Detalle completo de un DTE emitido | Certificado |
| `sii_list_documentos_recibidos` | Lista DTEs recibidos con filtros opcionales | Certificado |
| `sii_get_documento_recibido` | Detalle completo de un DTE recibido | Certificado |

## Desarrollo

```bash
npm test          # correr tests
npm run dev       # desarrollo con ts-node
npm run build     # compilar TypeScript
```
