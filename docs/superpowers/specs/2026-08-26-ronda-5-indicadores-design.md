# Ronda 5 — Indicadores y valores públicos

**Roadmap:** `2026-08-21-roadmap-homologacion-apigateway.md`
**Dominio:** `indicadores` (6 en el catálogo, 0 en producción)

## Fase 0 — Relevamiento: CERRADA (2026-08-26)

Los seis indicadores son implementables. Todos responden HTTP 200 con **tablas
reales en el HTML servido**, sin JavaScript armando el contenido — o sea que se
parsean del fuente, sin renderizar.

| Indicador | URL (por año) | Estructura |
|---|---|---|
| UF | `uf/uf<AÑO>.htm` | 10 tablas, 140 filas: días × meses |
| UTM / UTA / IPC | `utm/utm<AÑO>.htm` | 1 tabla, 14 filas (una por mes) |
| Dólar | `dolar/dolar<AÑO>.htm` | 9 tablas, 121 filas |
| Corrección monetaria | `correccion_monetaria/correccion<AÑO>.htm` | 1 tabla, 156 celdas |
| Impuesto 2ª categoría (art. 43) | `impuesto_2da_categoria/impuesto<AÑO>.htm` | 9 tablas, 315 filas de tramos |
| Impuesto 2ª categoría (art. 52 bis) | `impuesto_2da_categoria/impuesto<AÑO>_art52.htm` | 9 tablas, 99 filas |

Base: `https://www.sii.cl/valores_y_fechas`.

### Lo que hace distinta a esta ronda

**No hay credencial, ni sesión, ni cookie jar.** Son páginas públicas: se piden
con `fetch` directo. Es la única ronda que no toca el modelo de sesión, que es la
parte delicada del sistema.

Consecuencias de diseño:

- Las rutas REST **no llevan `rut` ni credencial**. Rompen el patrón de todas las
  demás, y eso hay que documentarlo explícito o alguien va a mandar una clave
  creyendo que hace falta.
- Se parecen más a `/v1/contribuyente/situacion-tributaria` (pública) que al
  resto: **conviene reusar su caché**. Un valor de UF de un día pasado no cambia
  nunca, así que el TTL puede ser mucho más largo que las 24 h de la situación
  tributaria — para años cerrados, indefinido.
- **Igual van con ritmo.** Que no haya credencial no significa que el SII no
  cuente las requests: el corte por volumen del RCV fue por patrón de uso, no por
  sesión. Ver `ritmoSii.ts`.

### Trampas ya identificadas

- **Latin1, como todo el SII.** `resp.text()` asume UTF-8 y rompe los acentos:
  hay que leer el buffer y decodificar a mano (`decodificarRespuesta`).
- **Los valores vienen con formato chileno** (`40.875,09`): punto de miles y coma
  decimal. Parsearlos con `Number()` da `NaN` o, peor, un número equivocado si
  alguien "limpia" sólo la coma.
- **Un día sin valor no es un cero.** Las tablas de UF y dólar tienen celdas
  vacías —feriados, días futuros del año en curso— y publicar 0 ahí sería
  inventar un tipo de cambio. Van en `null`.
- **El año en curso está incompleto** por definición: la tabla llega hasta hoy.
  Un consumidor que pida diciembre en agosto tiene que poder distinguir "no hay
  dato todavía" de "el SII no lo informa".

## Alcance propuesto

Una ruta por indicador, todas con `{ anio }` y sin credencial:

- `POST /v1/indicadores/uf` — valores diarios del año.
- `POST /v1/indicadores/utm` — UTM, UTA e IPC por mes.
- `POST /v1/indicadores/dolar` — valores diarios (y euro, si la página lo trae).
- `POST /v1/indicadores/correccion-monetaria`
- `POST /v1/indicadores/impuesto-segunda-categoria` — tramos por mes, con el
  artículo (43 o 52 bis) como parámetro.

A confirmar al implementar: si conviene además una consulta por FECHA puntual
(`{ fecha }` → un solo valor), que es como se usa en la práctica —para convertir
un monto de un día— en vez de bajar el año entero y que el consumidor busque.

## Criterio de terminado

Igual que la ronda 1, más una específica: **verificar contra la página del portal
que los valores coinciden**, no sólo que el parseo no falle. Un parser de tablas
que agarra la columna corrida devuelve números plausibles y equivocados.
