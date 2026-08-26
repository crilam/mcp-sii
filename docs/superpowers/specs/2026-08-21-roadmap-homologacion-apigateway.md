# Roadmap — Homologación del catálogo apigateway.cl en mcp-sii

> **Revisado el 2026-08-26.** La versión del 21-08 tenía dos supuestos que
> dejaron de ser ciertos en cinco días; están corregidos abajo y marcados con
> «CORRECCIÓN». Es el motivo por el que este roadmap NO especifica las rondas
> lejanas: envejecen mal. Cada ronda se especifica al empezar.

## Objetivo

Replicar en mcp-sii la FUNCIONALIDAD del catálogo de apigateway.cl (v1 legacy /
v2), exponiéndola por REST (multi-tenant) y MCP, sobre la arquitectura de
sesión + scraping + `SiiHttpClient` existente. Formato propio de mcp-sii
(`{ok, ...datos}`, rutas `/v1/<dominio>/<accion>`), no compatibilidad literal
de rutas con apigateway (decisión previa del usuario).

## Universo (104 endpoints del catálogo v2, superset de v1)

SII: dte 16, rcv 12, mipyme 11, bienes_raices 10, bte 9, bhe 9, eboleta 7,
indicadores 6, f29 5, vehiculos 4, rtc 4, misii 4, contribuyentes 3.
No-SII: previred 3, connections 1 (infra del gateway, fuera de alcance).

**El conteo es de segunda mano y conviene tratarlo como orientativo.** La
documentación de apigateway es una SPA: no se puede enumerar por fetch, y los
intentos de traerla devuelven el landing. Por eso **la primera tarea de cada
ronda es relevar su dominio contra la documentación real** (con navegador) y
ajustar el alcance antes de escribir código. Planificar sobre un conteo que
nadie puede verificar es cómo se llega a una ronda que "faltaba la mitad".

Tampoco hay correspondencia 1:1 con nuestras rutas: `/v1/bhe/resumen` cubre de
una lo que allá son varias llamadas, y tenemos cosas que ese catálogo no
tiene —renta (`f22`, estado de declaración) y `validar-clave`.

## Dos mundos por arquitectura

**Mundo A — replicable con scraping del portal (lo que mcp-sii ya hace).**
Consulta y escritura vía el portal web del SII. Es el grueso del roadmap.

**Mundo B — requiere un cliente de las APIs OFICIALES del SII con firma digital
y folios CAF** (lo que apigateway construyó como LibreDTE). NO es scraping: es
firmar XML DTE, solicitar/usar CAF, enviar al SII y consultar acuses. Es un
proyecto del tamaño de un producto. Incluye: **dte/caf, dte emisión y envío,
bte (emisión/recepción), eboleta (emisión), rtc/cesiones**.

**CORRECCIÓN (2026-08-26) sobre el dominio `dte`:** la doc de apigateway lo
describe como «verificación de DTE, obtención de archivo CAF, folios
disponibles y anulación de folios». O sea que sus 16 endpoints son casi todos
mundo B, y NO son el equivalente de nuestras rutas `/v1/dte/list-*`, que son
consultas del portal. Por eso `dte` no abre las rondas pese a ser el dominio
más grande: se ordena por tamaño **dentro del mundo A**.

**Fuera de alcance permanente:** previred (fuente distinta al SII),
connections (billing del propio gateway).

## Estado real a 2026-08-26

En producción, 19 rutas REST:

| Dominio | Rutas hoy |
|---|---|
| bhe | resumen, resumen-recibidas, list-emitidas, list-recibidas, pdf |
| dte | list-documentos-{emitidos,recibidos}, get-documento-{emitido,recibido} |
| rcv | resumen, detalle |
| renta | estado-declaracion, f22 |
| mipyme | list-empresas, list-dte-emitidos, emitir-dte (sólo previsualización) |
| persona | bienes-raices |
| contribuyente | situacion-tributaria |
| sesion | validar-clave |

**CORRECCIÓN (2026-08-26) — el pass-through por clave SÍ funciona.** La versión
anterior decía que se había descartado (queue-it + F5 WAF, sin sesión
reutilizable). Eso cambió: desde el PR #55, todas las rutas de consulta aceptan
**clave tributaria O certificado**, verificado contra el SII real atravesando
los handlers REST. El certificado quedó como requisito de una sola ruta,
`mipyme/emitir-dte`, porque firmar necesita el certificado de verdad.

Es la corrección que más afecta al roadmap: los dominios que se planificaban
"sólo con certificado" pueden hacerse con clave, que es la credencial que los
usuarios de Tributy ya tienen cargada. **Toda ronda nueva nace con
`conCredencial` (clave o certificado), no con `zodCredencialCert`.**

## Rondas (mundo A, por tamaño de dominio)

Cada ronda = relevamiento + spec + plan + ejecución + PR(s) + deploy +
verificación en prod + aviso a los consumidores si cambia el contrato.

| # | Dominio | En catálogo | Hoy | Notas |
|---|---|---:|---:|---|
| **R1** | **rcv** | 12 | 2 | RCV asíncrono (el SII procesa detalles grandes en background) y escritura de registro. Ya especificado en parte, ver ronda 1. |
| R2 | mipyme | 11 | 3 | Lectura restante (info-contribuyente, list-dte-recibidos, dte-pdf/xml) y borradores. |
| R3 | bienes_raices | 10 | 1 | Comunas, certificados de avalúo y antecedentes (data y PDF). |
| R4 | bhe | 9 | 5 | Consultas por terceros, y la paginación de recibidas >100 que hoy falla explícito. |
| R5 | indicadores | 6 | 0 | UF, corrección monetaria, impuesto 2ª categoría. **Sin credencial**: páginas públicas. |
| R6 | f29 | 5 | 0 | Ya especificado en parte en el spec de empresa-lectura. |
| R7 | vehiculos | 4 | 0 | Tasación, categorías. Sin credencial. |
| R8 | misii | 4 | 0 | Representantes, representados, datos del contribuyente. |
| R9 | contribuyentes | 3 | 1 | Los dos restantes. |
| R10 | dte (parte A) | ? | 4 | Sólo lo que sea consulta de portal. El resto pasa al mundo B. |
| R11 | Escritura de portal | — | — | bhe emitir/anular, rcv set_tipo_transaccion/set_resumen, mipyme borradores. **Actos reales e irreversibles**: idempotencia y confirmación explícita. Spec con cuidado extra. |

**RE — Evaluación del mundo B.** Antes de comprometer diseño: spike sobre las
APIs oficiales del SII (firma XML, CAF), y decisión build-vs-integrar LibreDTE
con criterios escritos. Sale de acá el alcance de las rondas siguientes.

**R12+ — Mundo B**, según lo que decida RE. ~30 endpoints: bte 9, eboleta 7,
rtc 4, y la parte CAF/emisión de dte.

### Por qué este orden, y cuándo romperlo

El criterio es tamaño de dominio dentro del mundo A (decisión del usuario,
2026-08-26). Tiene una consecuencia que conviene tener a la vista: **deja para
el final lo más barato**. `indicadores` y `vehiculos` son 10 endpoints de
páginas públicas, sin credencial ni sesión — las rondas más simples de todo el
roadmap y las únicas que no tocan el modelo de sesión, que es la parte
delicada. Si en algún momento hace falta mostrar avance rápido, o entra alguien
nuevo al proyecto, R5 y R7 son el lugar por donde empezar.

## Principios (heredados, actualizados)

- REST multi-tenant, auth por API key + rate-limit + auditoría (ya en prod).
- **Credencial: `conCredencial` (clave o certificado)**, salvo que la operación
  firme. Ver corrección arriba.
- Contrato `{ok, ...}` con status 200 para los errores de negocio. Códigos:
  `BAD_REQUEST` (400), `CREDENCIALES_INVALIDAS`, `NO_ENCONTRADO`,
  `LIMITE_CONOCIDO`, `SESIONES_SIMULTANEAS`, `ERROR`. **`RUT_INVALIDO` no
  existe** — la versión anterior de este roadmap lo listaba; un RUT mal formado
  es `BAD_REQUEST` con `detalle`.
- Binarios (pdf/xml) como base64 + contentType, con validación de magic bytes.
- TDD, un PR por dominio, verificación e2e contra el REST **desplegado**.
- MCP + REST expuestos a la par.
- **Ningún dato real versionado.** El repo tiene un chequeo de anonimización que
  corre en CI; ya frenó un RUT de empresa real con su razón social en un
  fixture. Los RUT de prueba son de dígito repetido.
- **Un `null` significa "el SII no informa esto", nunca cero.** Y ante una
  respuesta que no se puede leer con confianza, se falla explícito en vez de
  devolver un dato incompleto que se lea como completo.

## Realidad de esfuerzo

Mundo A (R1-R11): factible con la arquitectura actual, semanas por ronda.
Mundo B (R12+): proyecto mayor, y una parte compite con años de un producto
comercial. "Todos los servicios de apigateway" ≠ una tarea: es este roadmap
completo.
