/**
 * Parámetros tributarios y previsionales con vigencia.
 *
 * Esta es la pieza que sostiene la regla central del proyecto: **ningún
 * parámetro se infiere**. Las tasas, los topes, los tramos, las unidades de
 * reajuste y los códigos de formulario entran como dato cargado y validado.
 *
 * Todo lo demás en este sistema se pudo verificar contra el portal del SII.
 * Estos valores no: no hay endpoint que los devuelva. Un motor que los genere
 * por inferencia produce resultados **plausibles**, que es el peor modo de
 * falla en algo que liquida sueldos y determina impuestos — el número se ve
 * razonable y está mal.
 *
 * Por eso, cuando falta un parámetro para el período que se está calculando, el
 * cálculo **falla nombrando cuál falta**. Nunca arrastra el del mes anterior ni
 * cae a un valor por defecto: un parámetro desactualizado tiene que ser un
 * error ruidoso, no una liquidación silenciosamente incorrecta.
 */
import { type ClavePeriodo } from '../dominio/periodos';

export interface ValorVigente {
  /** Desde qué período rige, inclusive. */
  readonly desde: ClavePeriodo;
  /** Hasta qué período rige, inclusive. `null` significa que sigue vigente. */
  readonly hasta: ClavePeriodo | null;
  readonly valor: number;
  /** De dónde salió: circular, resolución, tabla de Previred, página del SII. */
  readonly fuente: string;
}

export interface DefinicionDeParametro {
  readonly nombre: string;
  /** Qué es, en palabras de quien sabe de impuestos y no de software. */
  readonly descripcion: string;
  readonly unidad: 'pesos' | 'porcentaje' | 'utm' | 'uf' | 'codigo' | 'cantidad';
  readonly valores: readonly ValorVigente[];
}

export class ParametroFaltante extends Error {
  constructor(
    readonly nombre: string,
    readonly periodo: ClavePeriodo,
    readonly descripcion?: string,
  ) {
    super(
      `Falta el parámetro "${nombre}" para el período ${periodo}` +
        (descripcion !== undefined ? ` (${descripcion})` : '') +
        '. No se calcula con el valor de otro período: cargá el vigente y volvé a intentar.',
    );
    this.name = 'ParametroFaltante';
  }
}

export class ParametrosInconsistentes extends Error {
  constructor(readonly problemas: readonly string[]) {
    super(`Tabla de parámetros inconsistente:\n  ${problemas.join('\n  ')}`);
    this.name = 'ParametrosInconsistentes';
  }
}

export class TablaDeParametros {
  private readonly porNombre: ReadonlyMap<string, DefinicionDeParametro>;

  private constructor(definiciones: readonly DefinicionDeParametro[]) {
    this.porNombre = new Map(definiciones.map((d) => [d.nombre, d]));
  }

  /**
   * Construye la tabla validándola entera. Los rangos que se solapan son el
   * error peligroso: dos valores vigentes a la vez hacen que el resultado
   * dependa del orden de la lista, y eso cambia sin que nadie lo note.
   */
  static desde(definiciones: readonly DefinicionDeParametro[]): TablaDeParametros {
    const problemas: string[] = [];
    const vistos = new Set<string>();

    for (const definicion of definiciones) {
      if (vistos.has(definicion.nombre)) {
        problemas.push(`parámetro duplicado: ${definicion.nombre}`);
      }
      vistos.add(definicion.nombre);

      if (definicion.valores.length === 0) {
        problemas.push(`${definicion.nombre} no tiene ningún valor cargado`);
      }

      for (const valor of definicion.valores) {
        if (valor.hasta !== null && valor.hasta < valor.desde) {
          problemas.push(
            `${definicion.nombre}: el rango ${valor.desde}–${valor.hasta} termina antes de empezar`,
          );
        }
        if (valor.fuente.trim() === '') {
          problemas.push(
            `${definicion.nombre} (${valor.desde}): sin fuente. ` +
              'Un parámetro sin fuente no se puede auditar ni actualizar con confianza.',
          );
        }
        if (!Number.isFinite(valor.valor)) {
          problemas.push(`${definicion.nombre} (${valor.desde}): el valor no es un número finito`);
        }
      }

      const ordenados = [...definicion.valores].sort((a, b) => a.desde.localeCompare(b.desde));
      for (let i = 1; i < ordenados.length; i += 1) {
        const anterior = ordenados[i - 1] as ValorVigente;
        const actual = ordenados[i] as ValorVigente;
        if (anterior.hasta === null || anterior.hasta >= actual.desde) {
          problemas.push(
            `${definicion.nombre}: los rangos que empiezan en ${anterior.desde} y ${actual.desde} ` +
              'se solapan, así que habría dos valores vigentes a la vez',
          );
        }
      }
    }

    if (problemas.length > 0) throw new ParametrosInconsistentes(problemas);
    return new TablaDeParametros(definiciones);
  }

  /** El valor vigente, o un error que dice exactamente qué cargar. */
  valor(nombre: string, periodo: ClavePeriodo): number {
    const definicion = this.porNombre.get(nombre);
    if (definicion === undefined) throw new ParametroFaltante(nombre, periodo);

    const vigente = definicion.valores.find(
      (v) => v.desde <= periodo && (v.hasta === null || v.hasta >= periodo),
    );
    if (vigente === undefined) {
      throw new ParametroFaltante(nombre, periodo, definicion.descripcion);
    }

    return vigente.valor;
  }

  /** Si hay valor vigente, sin lanzar. Para mostrar qué falta antes de calcular. */
  tiene(nombre: string, periodo: ClavePeriodo): boolean {
    try {
      this.valor(nombre, periodo);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Revisa de una vez todo lo que un cálculo va a necesitar.
   *
   * Fallar en el primero obliga a cargar de a uno y volver a correr; esto
   * permite entregar la lista completa de lo que hay que ir a buscar.
   */
  faltantes(nombres: readonly string[], periodo: ClavePeriodo): readonly string[] {
    return nombres.filter((nombre) => !this.tiene(nombre, periodo));
  }

  exigir(nombres: readonly string[], periodo: ClavePeriodo): void {
    const faltan = this.faltantes(nombres, periodo);
    if (faltan.length === 0) return;

    throw new ParametrosInconsistentes(
      faltan.map((nombre) => {
        const definicion = this.porNombre.get(nombre);
        return definicion === undefined
          ? `falta el parámetro "${nombre}" para ${periodo}, y no está definido en la tabla`
          : `falta el valor de "${nombre}" para ${periodo} (${definicion.descripcion})`;
      }),
    );
  }

  definiciones(): readonly DefinicionDeParametro[] {
    return [...this.porNombre.values()];
  }
}
