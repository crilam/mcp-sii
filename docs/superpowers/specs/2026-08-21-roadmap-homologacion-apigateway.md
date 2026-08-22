# Roadmap — Homologación del catálogo apigateway.cl en mcp-sii

## Objetivo

Replicar en mcp-sii la FUNCIONALIDAD del catálogo de apigateway.cl (v1 legacy /
v2), exponiéndola por REST (multi-tenant, pass-through de certificado) y MCP,
sobre la arquitectura de sesión + scraping + `SiiHttpClient` existente. Formato
propio de mcp-sii (`{ok, ...datos}`, rutas `/v1/<dominio>/<accion>`), no
compatibilidad literal de rutas con apigateway (decisión previa del usuario).

## Universo (104 endpoints del catálogo v2, superset de v1)

SII: dte 16, rcv 12, mipyme 11, bienes_raices 10, bte 9, bhe 9, eboleta 7,
indicadores 6, f29 5, vehiculos 4, rtc 4, misii 4, contribuyentes 3.
No-SII: previred 3, connections 1 (infra del gateway, fuera de alcance).

## Dos mundos por arquitectura

**Mundo A — replicable con scraping del portal + certificado (lo que mcp-sii ya
hace).** Consulta y escritura vía el portal web del SII. Es el grueso del
roadmap.

**Mundo B — requiere un cliente de las APIs OFICIALES del SII con firma digital
y folios CAF** (lo que apigateway construyó como LibreDTE). NO es scraping: es
firmar XML DTE, solicitar/usar CAF, enviar al SII y consultar acuses. Es un
proyecto del tamaño de un producto. Se especifica aparte, después del mundo A.
Incluye: **dte/caf, dte emisión y envío, bte (emisión/recepción), eboleta
(emisión), rtc/cesiones (factoring electrónico)**.

**Fuera de alcance permanente:** previred (fuente distinta al SII),
connections (billing del propio gateway).

## Prerrequisito — HECHO ✅

**Fase 0: pass-through de certificado** (PRs #41-#43, en prod y verificado).
El REST recibe el `.pfx` en base64 + password por request y arma sesión por
certificado. Arregló además el bug de prod (rutas por credencial no
funcionaban). El clave pass-through se descartó (queue-it + F5 WAF, sin sesión
reutilizable — ver spec del sub-proyecto 1).

## Sub-proyectos (orden de ejecución, lectura primero)

Cada uno = su propia spec + plan + ejecución SDD + PR(s) + deploy. Cada uno
produce software funcionando y verificable en prod.

### SP1 — Empresa/consulta (EN CURSO, Fase 0 hecha)
Spec: `2026-08-21-homologacion-empresa-lectura-design.md`. Dominios: **rcv async,
f29, mipyme lectura restante, contribuyentes públicos**. Mundo A, lectura.
Estado: Fase 0 en prod; faltan los 4 dominios.

### SP2 — Persona/consulta
**bhe lectura restante** (pdf, consultas_por_terceros), **misii**
(representantes, representados, datos del contribuyente), **bienes_raices
restante** (comunas, certificados de avalúo/antecedentes: data y pdf).
Mundo A, lectura. Reusa el camino binario (getBuffer) de SP1.

### SP3 — Indicadores y catálogos públicos
**indicadores** (uf, corrección monetaria, impuesto 2da categoría),
**vehiculos** (tasación, categorías). Sin credencial (páginas públicas del SII).
Mundo A, lectura. Los más simples; útiles como fuente única.

### SP4 — Escritura de portal (mundo A, escritura)
Lo que se emite/modifica VÍA EL PORTAL con certificado, sin CAF:
**mipyme borradores** (emitir/eliminar), **bhe emitidas** (emitir/anular),
**rcv** (set_tipo_transaccion, set_resumen). Requiere idempotencia y
confirmaciones explícitas (acto real e irreversible). Spec con cuidado extra.

### SP5+ — Mundo B (APIs oficiales + firma + CAF) — spec y arquitectura aparte
**dte/caf** (solicitud y uso de folios), **dte emisión/envío/acuses**, **bte**,
**eboleta emisión**, **rtc/cesiones**. Cada uno es grande. Requiere: cliente de
los web services del SII, firma de XML con el certificado, manejo de CAF,
y probablemente un rediseño del modelo de credenciales (la firma server-side ya
existe parcialmente en mipymeHttp para DTE de portal, pero las APIs oficiales
son otro protocolo). Se decide si encararlo cuando termine el mundo A — puede
que convenga integrar LibreDTE en vez de reimplementarlo.

## Principios (heredados de SP1)

- REST multi-tenant, pass-through de certificado, auth por API key + rate-limit
  + auditoría (ya en prod).
- Contrato `{ok, ...}`; errores `BAD_REQUEST`/`CREDENCIALES_INVALIDAS`/`ERROR`/
  `NO_ENCONTRADO`/`RUT_INVALIDO`.
- Binarios (pdf/xml) como base64 + contentType, con validación de magic bytes.
- TDD, un PR por dominio, verificación e2e contra el REST DESPLEGADO (no solo
  la cadena local — lección de la Fase 0: el body-limit y curl-ausente solo
  aparecieron en prod).
- MCP + REST expuestos a la par.

## Realidad de esfuerzo

Mundo A (SP1-SP4): factible con la arquitectura actual, semanas de trabajo por
sub-proyecto. Mundo B (SP5+): proyecto mayor, evaluar build vs integrar
LibreDTE. "Todos los servicios de apigateway" ≠ una tarea: es este roadmap
completo, y una parte (mundo B) compite con años de un producto comercial.
