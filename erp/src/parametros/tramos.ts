/**
 * Tablas de tramos con vigencia: el impuesto único de segunda categoría y
 * cualquier otro impuesto progresivo.
 *
 * Un tramo no es un valor suelto, así que no cabe en `TablaDeParametros`. Pero
 * vale la misma regla: **los tramos no se inventan**. Se cargan desde la tabla
 * publicada del SII, con su período de vigencia y su fuente.
 */
import { type ClavePeriodo } from '../dominio/periodos';

export interface Tramo {
  /** Límite inferior, **inclusive**, en la unidad de la tabla. */
  readonly desde: number;
  /**
   * Límite superior, **exclusive**. `null` en el último tramo.
   *
   * Exclusivo y no inclusivo para que los tramos contiguos encajen exactamente:
   * con los dos extremos inclusivos, una renta que cae justo en el borde
   * pertenece a dos tramos y el resultado depende de cuál se evalúe primero.
   * Al cargar la tabla del SII, el `hasta` de un tramo es el `desde` del
   * siguiente.
   */
  readonly hasta: number | null;
  /** Factor que se aplica sobre la base. 0.04 es 4 %. */
  readonly factor: number;
  /**
   * Cantidad a rebajar del resultado, en la unidad de la tabla.
   *
   * La tabla del SII viene con rebaja precisamente para que el cálculo sea
   * `base × factor − rebaja` en un paso, en vez de acumular por tramos. Las dos
   * formas dan lo mismo sólo si la rebaja es la correcta, así que se carga tal
   * como la publica el SII en vez de derivarla.
   */
  readonly rebaja: number;
}

export interface TablaDeTramosVigente {
  readonly desde: ClavePeriodo;
  readonly hasta: ClavePeriodo | null;
  /** En qué unidad están `desde`, `hasta` y `rebaja`. */
  readonly unidad: 'utm' | 'uta' | 'pesos';
  readonly tramos: readonly Tramo[];
  readonly fuente: string;
}

export class TramosFaltantes extends Error {
  constructor(
    readonly nombre: string,
    readonly periodo: ClavePeriodo,
  ) {
    super(
      `Falta la tabla de tramos "${nombre}" para el período ${periodo}. ` +
        'No se calcula con la tabla de otro período: los tramos cambian y aplicar los del año ' +
        'pasado produce una retención que se ve razonable y está mal.',
    );
    this.name = 'TramosFaltantes';
  }
}

export class TramosInconsistentes extends Error {
  constructor(readonly problemas: readonly string[]) {
    super(`Tabla de tramos inconsistente:\n  ${problemas.join('\n  ')}`);
    this.name = 'TramosInconsistentes';
  }
}

export class TablaDeTramos {
  private constructor(
    readonly nombre: string,
    private readonly vigencias: readonly TablaDeTramosVigente[],
  ) {}

  /**
   * Valida la tabla entera al construirla.
   *
   * Los huecos y los solapamientos entre tramos son el error que importa: un
   * hueco deja una renta sin tramo aplicable, y un solapamiento hace que el
   * resultado dependa del orden. Los dos producen retenciones mal calculadas
   * sin que nada se vea roto.
   */
  static desde(nombre: string, vigencias: readonly TablaDeTramosVigente[]): TablaDeTramos {
    const problemas: string[] = [];

    for (const vigencia of vigencias) {
      if (vigencia.fuente.trim() === '') {
        problemas.push(`${vigencia.desde}: sin fuente; un tramo sin fuente no se puede auditar`);
      }
      if (vigencia.tramos.length === 0) {
        problemas.push(`${vigencia.desde}: no tiene tramos`);
        continue;
      }

      const ordenados = [...vigencia.tramos].sort((a, b) => a.desde - b.desde);

      if ((ordenados[0] as Tramo).desde !== 0) {
        problemas.push(
          `${vigencia.desde}: el primer tramo empieza en ${(ordenados[0] as Tramo).desde} y no en 0, ` +
            'así que las rentas menores quedan sin tramo aplicable',
        );
      }

      const ultimo = ordenados[ordenados.length - 1] as Tramo;
      if (ultimo.hasta !== null) {
        problemas.push(
          `${vigencia.desde}: el último tramo termina en ${ultimo.hasta}, así que una renta ` +
            'mayor quedaría sin tramo. El tramo superior tiene que ser abierto.',
        );
      }

      for (let i = 0; i < ordenados.length; i += 1) {
        const tramo = ordenados[i] as Tramo;
        if (tramo.hasta !== null && tramo.hasta < tramo.desde) {
          problemas.push(`${vigencia.desde}: el tramo ${tramo.desde}–${tramo.hasta} termina antes de empezar`);
        }
        if (tramo.factor < 0 || tramo.factor > 1) {
          problemas.push(
            `${vigencia.desde}: el factor ${tramo.factor} del tramo que empieza en ${tramo.desde} ` +
              'no está entre 0 y 1. ¿Está expresado en porcentaje en vez de fracción?',
          );
        }

        const siguiente = ordenados[i + 1];
        if (siguiente === undefined) continue;
        if (tramo.hasta === null) {
          problemas.push(`${vigencia.desde}: hay un tramo abierto que no es el último`);
          continue;
        }
        // Contiguos exactos: si se solapan, el borde cae en dos tramos; si hay
        // hueco, una renta intermedia no cae en ninguno. Las dos cosas producen
        // una retención mal calculada sin que nada se vea roto.
        if (siguiente.desde < tramo.hasta) {
          problemas.push(
            `${vigencia.desde}: los tramos que empiezan en ${tramo.desde} y ${siguiente.desde} ` +
              `se solapan (el primero llega hasta ${tramo.hasta})`,
          );
        } else if (siguiente.desde > tramo.hasta) {
          problemas.push(
            `${vigencia.desde}: queda un hueco entre ${tramo.hasta} y ${siguiente.desde}, ` +
              'así que una renta ahí no caería en ningún tramo',
          );
        }
      }
    }

    const porInicio = [...vigencias].sort((a, b) => a.desde.localeCompare(b.desde));
    for (let i = 1; i < porInicio.length; i += 1) {
      const anterior = porInicio[i - 1] as TablaDeTramosVigente;
      const actual = porInicio[i] as TablaDeTramosVigente;
      if (anterior.hasta === null || anterior.hasta >= actual.desde) {
        problemas.push(
          `las vigencias que empiezan en ${anterior.desde} y ${actual.desde} se solapan`,
        );
      }
    }

    if (problemas.length > 0) throw new TramosInconsistentes(problemas);
    return new TablaDeTramos(nombre, vigencias);
  }

  vigenteEn(periodo: ClavePeriodo): TablaDeTramosVigente {
    const vigencia = this.vigencias.find(
      (v) => v.desde <= periodo && (v.hasta === null || v.hasta >= periodo),
    );
    if (vigencia === undefined) throw new TramosFaltantes(this.nombre, periodo);
    return vigencia;
  }

  tiene(periodo: ClavePeriodo): boolean {
    try {
      this.vigenteEn(periodo);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Aplica la tabla a una base ya expresada en la unidad de la tabla.
   *
   * Devuelve el impuesto en esa misma unidad. Convertir a pesos es
   * responsabilidad de quien llama, porque necesita el valor de la unidad para
   * el período — que también es un parámetro cargado.
   */
  aplicar(base: number, periodo: ClavePeriodo): { impuesto: number; tramo: Tramo } {
    const vigencia = this.vigenteEn(periodo);
    const tramo = vigencia.tramos.find(
      (t) => base >= t.desde && (t.hasta === null || base < t.hasta),
    );

    if (tramo === undefined) {
      // La validación de construcción lo hace imposible; si ocurre, es que la
      // tabla se armó por otro camino y hay que decirlo, no devolver cero.
      throw new TramosInconsistentes([
        `la base ${base} no cae en ningún tramo de "${this.nombre}" vigente en ${periodo}`,
      ]);
    }

    const impuesto = base * tramo.factor - tramo.rebaja;
    return { impuesto: impuesto > 0 ? impuesto : 0, tramo };
  }
}
