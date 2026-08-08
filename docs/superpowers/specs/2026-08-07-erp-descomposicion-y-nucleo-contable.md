# ERP contable Pro Pyme (14D) — descomposición y diseño del núcleo

Fecha: 2026-08-07
Estado: diseño aprobado para el núcleo (sub-proyecto A). El resto es descomposición, no diseño.

## Qué se pidió

Un sistema que lleve la contabilidad completa de una empresa acogida al **Régimen Pro Pyme General (14 D N°3)** con contabilidad completa: partida doble, asientos, libros, balances y estado de resultados; que determine y permita pagar los impuestos mensuales; que liquide remuneraciones; y que cierre el año con la declaración de renta.

La emisión de documentos tributarios **queda fuera**: se hace en el portal del SII. Todo lo que este sistema hace contra el SII es de lectura.

## La restricción que ordena el diseño

Este proyecto nace sobre `mcp-sii`, donde cada afirmación se pudo verificar contra el portal real. Esa verificabilidad es la razón de que el código sea confiable: cuando el charset mentía se miraron los bytes, cuando el candado no protegía se reprodujo la carrera, cuando el total declarado no cuadraba se sumaron las filas.

**Para una parte importante de lo que se pide ahora, no existe esa fuente de verdad.** Las tasas de cotización previsional, los topes imponibles, los tramos del impuesto único de segunda categoría, el orden de imputación de los registros empresariales del 14D — nada de eso se descubre llamando a un endpoint. Un motor que los genere por inferencia produce resultados **plausibles**, que es el modo de falla más peligroso en un sistema que liquida sueldos y determina impuestos: el número se ve razonable y está mal.

De ahí la regla que atraviesa todo el diseño:

> **Ningún parámetro tributario o previsional se infiere. Todos entran como dato versionado con fecha de vigencia. Si falta un parámetro para el período que se está calculando, el cálculo falla nombrando cuál falta — nunca sustituye por el del período anterior ni por un valor por defecto.**

Esto no reduce el alcance: el motor se construye completo. Cambia de dónde vienen los números, y hace que un parámetro desactualizado sea un error ruidoso en vez de una liquidación silenciosamente incorrecta.

## Descomposición

Cinco sub-proyectos. Cada uno con su propio ciclo spec → plan → implementación → revisión.

**A. Núcleo contable.** Plan de cuentas, asientos de partida doble, mayor, períodos y cierre, auditoría. No sabe nada de impuestos ni de sueldos: sabe de débitos, créditos y saldos. Es la base de todo lo demás y el único sub-proyecto cuyo diseño se detalla acá.

**B. Ingesta y motor de reglas.** Trae compras, ventas y honorarios desde `mcp-sii`, los concilia contra lo ya registrado, y los convierte en asientos aplicando reglas. Reglas primero, agente para lo que ninguna regla cubre; una propuesta del agente aprobada se convierte en regla.

**C. Determinación mensual.** Débito fiscal, crédito fiscal, remanente, PPM, retenciones. Arma el F29 y lo deja listo para presentar en el portal. Los insumos son verificables contra el SII; la aritmética es del sistema.

**D. Remuneraciones.** Liquidaciones, cotizaciones, impuesto único, gratificación, libro de remuneraciones. **Depende enteramente de tablas de parámetros cargadas.** Genera los asientos que consume A y las retenciones que consume C.

**E. Cierre anual y renta.** Ajustes de cierre, corrección monetaria, determinación de RLI, registros empresariales del 14D, insumos para el F22. El más dependiente de reglas externas y el último en construirse, porque consume el resultado correcto de todos los anteriores.

**Orden:** A, luego B y C en secuencia, luego D, luego E. D y E requieren que las tablas de parámetros existan y estén validadas antes de que su cálculo signifique algo.

**Interfaz:** web, con el agente como asistente adentro. Se construye en paralelo desde B, no antes: hasta que haya asientos y conciliación que mostrar, no hay qué diseñar.

## Sub-proyecto A — Núcleo contable

### Qué es y qué no es

Es el libro oficial. Reemplaza, no complementa. Eso impone inmutabilidad, trazabilidad y cierre de períodos.

No calcula impuestos, no conoce el SII, no sabe qué es una factura. Recibe asientos y mantiene saldos. Todo lo tributario vive en los sub-proyectos que lo consumen.

### La distinción que define el modelo

**La inmutabilidad es del asiento, no del borrador.**

Un asiento propuesto por una regla o por el agente y todavía no aprobado **no es un asiento**: es un borrador. Vive en una bandeja, se edita libremente, se descarta sin dejar rastro contable. Recién al aprobarse entra al mayor, recibe número correlativo y queda congelado.

Un asiento congelado no se edita ni se borra nunca. Se corrige con un asiento de reversión que lo referencia. El mayor es append-only.

Sin esta separación, o bien el agente ensucia el libro oficial con propuestas, o bien cada corrección de una propuesta genera una reversión — ninguna de las dos es aceptable.

### Componentes

**Plan de cuentas.** Cuentas con código, nombre, tipo (activo, pasivo, patrimonio, resultado ganancia, resultado pérdida) y jerarquía padre-hijo. Sólo las cuentas hoja reciben movimientos. El tipo determina el signo natural y en qué estado aparece la cuenta.

Cambiar el tipo de una cuenta con movimientos cambia retroactivamente los estados financieros ya emitidos, así que está prohibido: se crea una cuenta nueva y se traspasa el saldo con un asiento.

**Asientos.** Cabecera con fecha, glosa, origen (manual, regla, agente, apertura, cierre) y referencia al documento que lo motiva. Líneas con cuenta, debe, haber y glosa propia.

Invariantes, verificadas al aprobar y no antes:
- Suma de debe igual a suma de haber, en la moneda de la contabilidad.
- Al menos dos líneas.
- Ninguna línea con debe y haber ambos distintos de cero.
- Ninguna línea con ambos en cero.
- Todas las cuentas existen, son hoja y están activas.
- La fecha cae dentro de un período abierto.

**Períodos.** Mensuales, con estado abierto o cerrado. Cerrar un período impide asientos con fecha dentro de él. Reabrir es una operación explícita, registrada con motivo y responsable, y sólo posible si no hay períodos posteriores cerrados.

El cierre mensual no genera asientos: sólo bloquea. El cierre anual sí — traspasa las cuentas de resultado a patrimonio y genera la apertura del ejercicio siguiente.

**Mayor y saldos.** El mayor es la vista de líneas por cuenta ordenadas por fecha. Los saldos se derivan de las líneas, no se almacenan como campo mutable; si el volumen lo exige más adelante, se agrega un saldo materializado por cuenta y período que se recalcula al aprobar, pero la fuente de verdad sigue siendo las líneas.

**Auditoría.** Cada transición de estado de un asiento — creado como borrador, editado, aprobado, revertido — queda registrada con quién, cuándo y qué cambió. La bandeja de borradores también se audita, aunque su contenido no sea contable: importa saber que el agente propuso algo y alguien lo rechazó.

### Reportes del núcleo

Tres, y son derivaciones del mayor, no tablas propias:

- **Balance de comprobación y saldos** por período: por cuenta, débitos, créditos y saldo. Es la verificación de que la partida doble cuadra.
- **Balance general** a una fecha: activo, pasivo y patrimonio, con el resultado del ejercicio incluido en patrimonio.
- **Estado de resultados** por rango de fechas: ingresos menos costos y gastos.

Los libros legales (diario y mayor) son estos mismos datos con formato de presentación, no una estructura distinta.

### Datos y tecnología

Postgres, servidor. Restricciones de integridad en el esquema, no sólo en la aplicación: un asiento descuadrado no debe poder existir en la base aunque la aplicación tenga un bug. La suma debe/haber por asiento se verifica con una restricción diferida o un disparador, porque es la invariante que hace que todo lo demás signifique algo.

Montos en enteros, en pesos. La contabilidad chilena en pesos no usa decimales, y punto flotante en montos es una fuente de descuadres que no vale la pena.

El esquema se diseña para ser legible por alguien que sabe contabilidad y no de software, porque un contador va a tener que validarlo.

### Multi-empresa

Se diseña desde el principio: toda entidad cuelga de una empresa, y no existe consulta que no filtre por ella. Retrofitear esto después toca todas las tablas y todas las consultas a la vez — la misma lección que dejó `mcp-sii`, donde la identidad de la persona quedó implícita y ahora hay que sacarla de ahí.

No implica multi-tenant con aislamiento fuerte todavía. Implica que la empresa es columna, no supuesto.

### Pruebas

La partida doble es un dominio con invariantes verificables, así que las pruebas se escriben contra las invariantes:

- Un asiento descuadrado se rechaza al aprobar, y también si se intenta insertar directo en la base.
- La suma de saldos deudores iguala la de acreedores, para cualquier conjunto de asientos aprobados.
- Un asiento aprobado no puede modificarse por ningún camino.
- Un asiento con fecha en período cerrado se rechaza.
- Una reversión deja el saldo neto en cero y ambos asientos visibles.
- El cierre anual deja las cuentas de resultado en cero y el patrimonio con el resultado incorporado.

Un caso de prueba con un juego de asientos reales de un mes completo, cuyo balance de comprobación se compara contra un resultado calculado a mano. Los tests que sólo ejercitan el código que los acompaña no detectan errores de modelo.

### Qué queda explícitamente fuera de A

Impuestos, sueldos, ingesta desde el SII, corrección monetaria, moneda extranjera, centros de costo, activos fijos y su depreciación. Cada uno entra cuando su sub-proyecto lo requiera. Agregarlos ahora sería diseñar contra necesidades que todavía no se conocen.

## Riesgo que hay que decir en voz alta

Un libro contable oficial y una liquidación de sueldos tienen consecuencias legales. Este sistema puede ser correcto en su aritmética y aun así estar mal en su criterio tributario, porque el criterio no es código: es normativa interpretada.

**El diseño debe ser validado por un contador antes de que este sistema reemplace al que la empresa usa hoy**, y las liquidaciones y declaraciones que produzca deben contrastarse en paralelo con el método actual durante al menos un ciclo completo antes de confiar en ellas.

---

# Estado al 7 de agosto de 2026

665 tests en 39 suites. `tsc` limpio, `npm run build` en verde.

## Construido

**A. Núcleo contable.** Plan de cuentas con jerarquía y detección de ciclos, calendario de períodos, borradores, asientos, mayor, balance de comprobación, balance general, estado de resultados, cierre del ejercicio y apertura del siguiente. Esquema Postgres con las invariantes adentro, incluido el cuadre como `CONSTRAINT TRIGGER` diferido al `COMMIT`. Repositorio con todo parametrizado y filtrado por empresa.

**B. Ingesta y reglas.** Documento normalizado, clave de idempotencia que respeta la contraparte extranjera, motor de reglas como datos en JSONB, conciliación al reingestar, y conector que traduce el detalle del RCV.

**C. Determinación mensual.** Tabla de parámetros con vigencia y fuente, determinación de IVA con remanente que nunca se asume, armado del F29.

**D. Remuneraciones.** Motor de liquidación completo, tabla de tramos para impuestos progresivos, y el puente que convierte la nómina en asiento.

**E. Renta.** Determinación de RLI a partir del resultado contable, con clasificación tributaria por cuenta.

## Lo que falta, y por qué

**Los valores de todos los parámetros.** El sistema tiene la estructura y ningún número real: tasas de AFP, topes imponibles, tramos del impuesto único, valores de UF y UTM, códigos del F29 y del F22. Están vacíos a propósito. Cargarlos es trabajo de quien tenga la fuente autorizada, y hasta que estén cargados el sistema **se niega a calcular** en vez de inventar.

**Los registros empresariales del 14D — RAI, DDAN, REX y SAC.** No están implementados, y no es por falta de tiempo.

Estos registros tienen un orden de imputación que determina qué crédito se asigna a cada retiro y en qué prelación se consumen los saldos. A diferencia de una tasa, que es un número que alguien puede cargar en una tabla, el orden de imputación es un **algoritmo**: no basta con parametrizar un valor, hay que codificar la secuencia correcta. Y esa secuencia no la puedo verificar contra nada — no hay endpoint del SII que la devuelva, y escribirla de memoria produciría un resultado que parece razonable y determina mal los créditos de los socios.

Implementarla requiere que un contador especifique la secuencia, con sus casos de borde, antes de escribir la primera línea. Es el único lugar del proyecto donde el diseño mismo está bloqueado a la espera de esa especificación, y por eso está anotado acá en vez de resuelto a medias.

**La corrección monetaria.** Misma razón: es un procedimiento, no un parámetro.

**La interfaz.** El agente como asistente adentro, según lo conversado. No se empezó porque hasta ahora no había suficiente que mostrar.

## Antes de usarlo para algo real

1. Cargar los parámetros con su fuente.
2. Que un contador valide la secuencia de la liquidación y la determinación de RLI.
3. Correr un ciclo completo en paralelo con el método actual y contrastar.
4. Confirmar la regla de redondeo de las cotizaciones con quien lleva las remuneraciones hoy.
