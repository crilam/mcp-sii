# Fixtures del F29 — respuestas reales del SII, redactadas

Capturadas el 2026-09-06/07 contra el SII real. **Todo dato identificatorio está
sustituido**: RUT ficticio `11111111-1`, razón social "EMPRESA DE PRUEBA SPA",
dirección inventada, el RUT dentro de la traza del cálculo reemplazado, y los montos que
identificaban actividad real sustituidos por cifras ficticias. Lo que estos archivos
documentan es la FORMA de cada respuesta —nombres de campo, tipos, dónde hay `null`—, no
las cifras.

Los archivos son **JSON válido** —sin comentarios— para que se puedan `require`
directo desde un test. Lo que cada uno muestra:

## `f29-boletas-honorario-vacio.json`

getBoletasHonorario sobre una empresa SIN honorarios en el periodo. Convencion de "no hay dato": ceros y lista vacia, NO null ni error.

## `f29-complementos-asistentes-vacio.json`

getComplementosAsistentes con scoaTipo="123" y ningun asistente usado. Convencion distinta a la de boletas: NULL por posicion, no ceros. El array es POSICIONAL: indice 0 = tipo 1, indice 1 = tipo 2, indice 2 = tipo 3 (PPM).

## `f29-propuesta-declaracion-con-condiciones.json`

getDeclaracionConCondicionesYTipoPropuesta — respuesta REDACTADA. Estructura exacta del SII; RUT, razon social, direccion y comuna sustituidos. Ojo: los montos vienen como STRING, no como number.

## `f29-tasa-ppmo.json`

getTasaPPMO — respuesta REDACTADA. Mezcla tipos: cod563 y cod115 son string, mes y anno number, y varios campos vienen null.

## `f29-complementos-asistentes-tipo3.json`

`getComplementosAsistentes` de un período donde el asistente de PPM SÍ se usó
(`scoaRealizado: "S"`). Es el contraste del fixture vacío, y la evidencia de que el tipo 3
es PPM: trae `scoaPpmoCod563` y `scoaPpmoCod115` poblados mientras los campos de
honorarios siguen en `null`.

Ojo con los tipos acá: `scoaPpmoCod115` es **number** (`0.125`), al revés que el `"0.125"`
string de la propuesta. El mismo dato con dos tipos según el endpoint.

## Detalles de tipos que importan

- **Los montos vienen como `string`**, no como number, incluida la tasa (`"0.125"`).
- `f29-tasa-ppmo.json` es de un período **abierto**: trae `realizado: false`, y su
  `cod563` es el valor **propuesto**, no uno ya declarado.
- Conviven **dos convenciones distintas de "sin datos"**: `null` por posición en
  asistentes, ceros y lista vacía en boletas. Hay que tratarlas por endpoint.
- La traza redactada conserva `TOKEN[S]` y la forma real del texto: sólo se sustituyó el
  RUT. El informe advierte no loguearla tal cual, y el fixture muestra por qué.

## Pendiente: dos capturas que faltan

No son un detalle — son el hueco que va a doler al escribir un cliente:

- `getBoletasHonorario` **con** datos: el contribuyente de prueba no tiene boletas de
  honorarios en ningún período consultado, así que la forma de los elementos de
  `listBoletasHonorarios` no está relevada.
