import { LimitacionConocida } from './erroresConsulta';

// Red anti-doble-click para operaciones de ESCRITURA, compartida por el acuse
// del RCV y el guardado de borrador de mipyme. Una misma escritura repetida en
// una ventana corta es casi siempre un reintento del consumidor, no dos actos
// deliberados. La reserva es SÍNCRONA —antes de tocar el SII— para que dos
// requests concurrentes (el doble-click real) no pasen ambos. FAIL-SAFE: el
// default es MANTENER la reserva; sólo se libera si el error viene marcado como
// "el acto no se cursó" (validación pre-envío o rechazo determinístico del SII).
// Así un timeout de red ambiguo, o un error que otra capa envolvió perdiendo la
// marca, no habilita un segundo acto.

const MARCA = '__escrituraSeguraDeLiberar';

/** Marca un error como "el acto NO se cursó, es seguro liberar la reserva". */
export function marcarSeguro<E>(e: E): E {
  if (e && typeof e === 'object') (e as Record<string, unknown>)[MARCA] = true;
  return e;
}
export function esSeguroDeLiberar(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as Record<string, unknown>)[MARCA]);
}

export class VentanaIdempotencia {
  // clave → timestamp de la reserva. Mientras una clave esté acá, un segundo
  // acto idéntico se rechaza.
  private enCurso = new Map<string, number>();

  constructor(private ventanaMs = 60_000) {}

  /**
   * Ejecuta `fn` protegido por la ventana. Si otra ejecución con la misma
   * `clave` está en curso o terminó hace menos de `ventanaMs`, lanza
   * LimitacionConocida sin llamar a `fn`. Al terminar con éxito, refresca la
   * reserva; al fallar, la libera SÓLO si el error está marcado seguro.
   */
  async ejecutar<T>(clave: string, mensajeDuplicado: string, fn: () => Promise<T>): Promise<T> {
    const ahora = Date.now();
    for (const [k, ts] of this.enCurso) if (ahora - ts > this.ventanaMs) this.enCurso.delete(k);
    if (this.enCurso.has(clave)) throw new LimitacionConocida(mensajeDuplicado);
    // Reserva SÍNCRONA: entre este set y el await no hay suspensión, así que un
    // segundo request concurrente ya la encuentra.
    this.enCurso.set(clave, Date.now());
    try {
      const r = await fn();
      this.enCurso.set(clave, Date.now());
      return r;
    } catch (e) {
      if (esSeguroDeLiberar(e)) this.enCurso.delete(clave);
      throw e;
    }
  }

  /** Sólo para tests. */
  _reset(): void { this.enCurso.clear(); }
}
