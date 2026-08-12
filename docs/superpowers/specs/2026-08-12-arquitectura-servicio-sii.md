# mcp-sii como servicio externo: decisión de arquitectura

Fecha: 2026-08-12
Estado: **decisión tomada, sin implementar.** Registra el porqué y el orden de trabajo; ninguna de las piezas nuevas (cola por RUT, adaptador REST, Secrets Manager, egress IP) existe todavía.

Pregunta que lo motiva: las capacidades de `mcp-sii` (consultas RCV/BHE/renta,
emisión de DTE en el sistema gratuito, boletas a futuro) ¿se incorporan a **RDTE**
—el stack LibreDTE que opera Redcomercio— o quedan como servicio aparte? Y si es
aparte, ¿API pura o web de configuración multi-tenant?

Contexto que cambia la respuesta respecto de una lectura ingenua: no habrá un
solo consumidor. Ya hay tres a la vista —RDTE, el gateway de boletas de
Parkingapp, y Claude vía MCP— y vienen **AgenticERP** y, eventualmente, **vender
la conexión con el SII a terceros**. La decisión se toma para ese escenario, no
para el de hoy.

## Decisión 1: servicio externo, no dentro de RDTE

Cuatro razones, en orden de peso.

### a) Ciclos de vida opuestos

RDTE emite DTE por el camino oficial (XML + CAF propios): crítico, estable,
cambia poco, deploy pesado con gate PSR-12 y dependencias pineadas a refs
inmutables. `mcp-sii` **scrapea pantallas del SII**, y se rompe cuando el SII
cambia el HTML, sin aviso. Esta semana lo mostró: parsers con lookahead por los
`<option>` sin cerrar, entidades numéricas en la razón social, campos que sólo
están en arreglos JavaScript embebidos, un flujo de emisión que resultó tener
seis pasos y no tres. Eso exige deploys frecuentes e independientes. Acoplarlo a
RDTE mete lo frágil adentro de lo crítico.

### b) Portar todo a PHP legacy sería rehacer el trabajo

Todo lo relevado vive en TypeScript: parsers, fixtures capturadas del portal
real, ~450 tests, el flujo de firma con certificado centralizado. Reescribirlo en
sowerphp legacy (PHP 8.4 sobre un framework forkeado) es rehacerlo para correrlo
en el peor runtime disponible para esta tarea.

### c) El modelo de concurrencia de RDTE lo rompe — argumento técnico duro

El SII bloquea **sesiones simultáneas por RUT** (`01.01.190.500.720.27`), y la
empresa activa del portal es estado del lado del servidor atado a `CSESSIONID`
(medido: el POST de selección no escribe ninguna cookie). `mcp-sii` lo resuelve
con un candado por proceso (`conEmpresaExclusiva`). Una webapp PHP con Apache
prefork es **N procesos = N sesiones**: no puede dar la garantía de una sesión
por RUT ni siquiera para una empresa, menos para muchas. Aunque se quisiera
integrar, la arquitectura de RDTE viola la precondición.

### d) Complementan, no se pisan

RDTE cubre empresas con facturación propia. `mcp-sii` cubre lo que RDTE no ve:
RCV, BHE, renta, y el sistema **gratuito** del SII —empresas que por definición
no están en RDTE—. Consumidores distintos, dominios distintos.

**Lo que inclinaría la balanza al revés** (y no aplica): que RDTE fuera el único
consumidor para siempre y el equipo no quisiera operar un segundo servicio. Con
AgenticERP y la venta a terceros, eso ya es falso.

## Decisión 2: API headless + almacén de secretos, NO web multi-tenant propia

Tres opciones, y la correcta es la del medio.

- **API con env vars (lo de hoy)**: sirve para 5 empresas. No escala —rotar una
  clave o sumar una empresa es un redeploy— y guarda secretos en texto plano en
  la config del proceso. Inaceptable apenas se custodian credenciales de terceros.
- **Web de configuración multi-tenant propia**: es construir auth, UI y tenants
  que **RDTE ya tiene**. Duplica la administración de empresas y certificados.
- **El medio (elegido)**: servicio headless —un core con dos adaptadores, MCP
  (ya existe) y REST (nuevo)— con las credenciales en **AWS Secrets Manager**, un
  secreto por RUT (`sii/<rut>` → clave, ruta de cert, `SII_CERT_CLAVE_SII`).
  **Sin base de datos propia**: el servicio no tiene estado que persistir —las
  sesiones son efímeras y los datos viven en el SII—. Encaja con el estándar de
  secretos que el equipo ya usa en AWS, y Secrets Manager aporta auditoría de
  acceso, que al vender el servicio pasa de lujo a requisito.

Si algún día hace falta UI de alta de credenciales, se agrega **como pantalla en
RDTE** que escribe al Secrets Manager, no como web propia del servicio.

## Decisión 3: el límite es por RUT, no por IP — cola por RUT, no proxies

Es el punto que más se presta a confusión y el que define la pieza central del
servicio.

### El bloqueo que ya tenemos es por credencial

`01.01.190.500.720.27` se dispara por sesiones simultáneas del **mismo RUT**.
Salir por muchas IPs no lo evita: dos procesos que autentican el mismo RUT a la
vez se bloquean igual. **Los proxies no atacan este límite.**

Se resuelve subiendo el candado un nivel: de una cola global por proceso a una
**cola por RUT**. Mismo RUT → serializado; RUTs distintos → en paralelo. Eso es
multi-tenant real sin bloqueo, y es lo que hace que:

- un cliente no degrade a otro (RUTs distintos no compiten), y
- un mismo RUT no se autobloquee aunque lo consulten RDTE, AgenticERP y
  Parkingapp a la vez.

Como cada cliente trae **su propio RUT**, los clientes no compiten entre sí por
sesión: la contención existe sólo dentro de un RUT.

### El límite por IP existe, pero es futuro y distinto

El SII también hace rate-limiting / anti-scraping **por IP**. Con muchos clientes
y todo el egress desde una sola IP de AWS, el SII puede throttlear o banear esa
IP y caen todos juntos. *Ese* sí es un problema de IP, y la respuesta es egress
por IP configurable (proxies o IPs salientes).

Pero es un problema de **volumen**, no de arquitectura de hoy. No resolverlo
antes de tenerlo: no se conoce el umbral del SII, y un pool de proxies mal usado
**dispara** el anti-fraude en vez de evitarlo. Regla de oro cuando llegue el
momento: **una IP estable por RUT**, no rotación aleatoria —un RUT que salta de
IP entre requests le parece al SII una cuenta comprometida—.

Resumen de una línea: *los proxies no resuelven el bloqueo que ya tenemos (por
RUT → cola por RUT) y resuelven uno que todavía no tenemos (rate-limit por IP →
sólo a escala).*

## Forma del servicio

```
RDTE (LibreDTE)   ──┐
AgenticERP        ──┤
Parkingapp gateway ─┼──> sii-service  (Node/TS, hoy mcp-sii)
Claude (MCP)      ──┤       ├─ router: {rut, operación}
clientes externos ──┘       ├─ cola por RUT   ← serializa mismo RUT, paraleliza RUTs distintos
                            ├─ workers: N sesiones activas de RUTs distintos
                            ├─ core: scrapers + sesión (lo que ya existe)
                            ├─ adaptador MCP (existe) + adaptador REST (nuevo)
                            ├─ AWS Secrets Manager: credencial por RUT (+ auditoría)
                            └─ (futuro) egress IP configurable, una IP estable por RUT
```

## Orden recomendado

1. ~~**Cola por RUT.**~~ **Hecho (2026-08-12), con TDD.** El núcleo de
   concurrencia multi-tenant está armado y probado en aislamiento:
   - `ColaPorClave` (`src/colaPorClave.ts`): serializa misma clave, paraleliza
     claves distintas.
   - `RegistroSesiones<T>` (`src/registroSesiones.ts`): una sesión por RUT,
     factory async (para Secrets Manager), sin doble creación bajo concurrencia.
   - Cookie jar y PEM por credencial (`src/rutaTemporalSii.ts` + `SessionManager`):
     eran constantes globales que colisionaban entre credenciales.
   - `ProveedorCredenciales` + `CredencialesEnMemoria` (`src/credenciales.ts`).
   - `crearRegistroSesionesSii` (`src/registroSesionesSii.ts`): la factory real.

   Falta sólo el **cableado del servidor**: `server.ts` sigue creando un
   `SessionManager` único (mono-credencial). El registro es la vía multi-tenant
   nueva, en paralelo; el MCP actual no se rompe.
2. **Antes de vender — Secrets Manager + adaptador REST.** Un secreto por RUT
   (ver sección de infra abajo); el REST expone las mismas operaciones que hoy da
   el MCP, ruteando por `registro.ejecutar(rut, …)`, para RDTE y Parkingapp. El
   swap de credenciales es de una línea: `CredencialesSecretsManager implements
   ProveedorCredenciales` en lugar de `CredencialesEnMemoria`.
3. **Cuando el volumen lo pida (no antes) — egress IP configurable**, una IP
   estable por RUT.

## Infra: custodia de credenciales en AWS Secrets Manager

> **Estado:** diseño, sin aplicar. Escrito de conocimiento —el AWS MCP no estaba
> disponible al redactarlo—. **Dos puntos marcados con ⚠ hay que verificar contra
> la doc de AWS antes de aplicar.** No requiere ninguna imagen ni servidor
> propio: Secrets Manager es un servicio administrado.

### Modelo, no "token por clave"

No se mintea un token de lectura por secreto (eso es Vault, no AWS). En AWS el
acceso se controla con **políticas IAM que apuntan a ARNs**, asumidas por un
**rol** que toma el compute (task role en ECS/Fargate, instance profile en EC2,
execution role en Lambda). La credencial temporal la reparte y rota STS sola: no
hay token estático que guardar en un `.env`. Eso reemplaza al `SII_CERT_CLAVE_SII`
de hoy —la clave deja de vivir en `.env` y pasa a Secrets Manager cifrada—.

### Convención de nombres = unidad de permiso

Un secreto por RUT bajo un prefijo común:

```
sii/11111111-1   → { rut, certPath|certB64, certPassword, claveCertificadoSii }
sii/22222222-2
```

El prefijo `sii/` es lo que permite dar permiso al conjunto sin enumerar cada
secreto. ⚠ **El ARN lleva un sufijo aleatorio** (`...secret:sii/11111111-1-AbCd12`),
por eso las políticas usan `sii/*` con comodín y nunca el ARN exacto — verificar
que `sii/*` cubre ese sufijo y no deja un borde.

### Lectura/escritura como subconjunto = dos roles

- **Rol del servicio (runtime)** — sólo `secretsmanager:GetSecretValue` sobre
  `sii/*`. Es el que usa mcp-sii para leer la credencial de cada RUT.
- **Rol de alta/administración** — `CreateSecret`/`PutSecretValue`/`UpdateSecret`
  sobre `sii/*`, separado del anterior. Dar de alta un cliente no es una
  operación del runtime.

### Que el rol del servicio NO pueda leer otros secretos de la cuenta

IAM es *deny by default*: un rol cuyo único permiso de Secrets Manager es leer
`sii/*` **no puede tocar nada más**. El aislamiento se garantiza con tres
candados, de imprescindible a defensa en profundidad:

1. **Least-privilege literal.** El rol lleva SÓLO la política de abajo y ninguna
   otra de Secrets Manager. El error que rompe esto es adjuntar la managed policy
   **`SecretsManagerReadWrite`** (tiene `Resource: "*"`, da toda la cuenta) o
   cualquier `secretsmanager:*` / `Resource: "*"`. El rol debe ser **dedicado**.

   ```json
   {
     "Effect": "Allow",
     "Action": "secretsmanager:GetSecretValue",
     "Resource": "arn:aws:secretsmanager:<region>:<cuenta>:secret:sii/*"
   }
   ```

2. **Deny explícito** — gana sobre cualquier Allow, blinda contra una política
   amplia que alguien adjunte al rol en el futuro:

   ```json
   {
     "Effect": "Deny",
     "Action": "secretsmanager:*",
     "NotResource": "arn:aws:secretsmanager:<region>:<cuenta>:secret:sii/*"
   }
   ```

3. **CMK dedicada (el candado que sella).** Leer un secreto exige, además del
   permiso al secreto, poder **descifrar su clave KMS**. Cifrar `sii/*` con una
   **CMK propia** (no la clave por defecto de Secrets Manager) y dar al rol
   `kms:Decrypt` **sólo sobre esa CMK**. Resultado: aunque IAM fallara y el rol
   terminara con `GetSecretValue` sobre `*`, **no podría leer ningún otro secreto
   de la cuenta**, porque no tiene la clave para descifrarlos. Doble llave.

⚠ Evaluar además una **resource-policy en cada secreto** (política adjunta al
secreto, no al rol) restringiendo el principal — tercer punto de control que
algunos equipos exigen para multi-tenant. Verificar si aporta sobre los tres
candados o es redundante en este caso.

### Verificación antes de confiar

- **IAM Policy Simulator**: `GetSecretValue` sobre `sii/11111111-1` debe permitir;
  sobre cualquier otro secreto de la cuenta debe negar. Prueba directa del
  aislamiento.
- **IAM Access Analyzer**: detecta si el rol quedó con acceso más amplio del
  previsto.

### El certificado también es secreto

El `.pfx` en sí (no sólo su clave) es material sensible de terceros. `certPath`
apuntando a un archivo local no escala multi-tenant: o va como binario en el
propio secreto (`certB64` base64 en el JSON) o en S3 cifrado con la misma CMK y
acceso por el mismo rol. Decidir al implementar `CredencialesSecretsManager`.

### Rotación

⚠ Secrets Manager ofrece rotación automática, pero acá **no es trivial**: la
clave del certificado la define el usuario en el SII, no la genera AWS, así que no
se puede rotar sin coordinar con el contribuyente. Tratar estos secretos como
rotación **manual/asistida**, no automática. Verificar el impacto antes de
activar cualquier schedule de rotación.

## Qué NO hacer

- No portar `mcp-sii` a PHP dentro de RDTE.
- No construir una web de configuración multi-tenant propia: usar RDTE + Secrets
  Manager.
- No comprar/configurar proxies para el bloqueo actual: ese es por RUT y se
  resuelve con la cola.
- No rotar IPs aleatoriamente cuando llegue el egress por IP: rompe más de lo que
  arregla.
- No adjuntar la managed policy `SecretsManagerReadWrite` al rol del servicio:
  da `Resource: "*"` y anula todo el aislamiento por prefijo.
- No cifrar `sii/*` con la clave KMS por defecto de Secrets Manager: sin CMK
  dedicada se pierde el tercer candado (el que sella el acceso cruzado).
- No activar rotación automática sobre estos secretos: la clave la controla el
  contribuyente en el SII, no AWS.
