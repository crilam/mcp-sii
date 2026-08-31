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

/**
 * Marca un error como "el acto NO se cursó, es seguro liberar la reserva". La
 * propiedad se define NO enumerable para que no se filtre si alguna capa
 * serializa el error (`{...e}` o un logger que vuelca props).
 */
export function marcarSeguro<E>(e: E): E {
  // `defineProperty` sobre un objeto congelado/no extensible tiraría TypeError
  // desde dentro de un catch, tapando el error original. Se chequea antes.
  if (e && typeof e === 'object' && Object.isExtensible(e)) {
    Object.defineProperty(e, MARCA, { value: true, enumerable: false, configurable: true });
  }
  return e;
}
export function esSeguroDeLiberar(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as Record<string, unknown>)[MARCA]);
}

export class VentanaIdempotencia {
  // clave → { ts, enVuelo }. `enVuelo` = la operación todavía corre contra el
  // SII; mientras lo esté, la reserva NO expira (una operación lenta —el caso
  // más probable de doble-click, porque el usuario reintenta PORQUE tardó— no
  // debe barrerse a mitad). Terminada, `ts` marca desde cuándo cuenta la ventana.
  private enCurso = new Map<string, { ts: number; enVuelo: boolean }>();

  // Tope duro para una reserva EN VUELO cuya promesa nunca resuelve (un cuelgue
  // de `fn`): pasado esto se barre igual, para no bloquear esa clave para
  // siempre. Muy por encima de cualquier operación real contra el SII.
  private readonly topeEnVueloMs: number;

  constructor(private ventanaMs = 60_000) {
    this.topeEnVueloMs = Math.max(ventanaMs * 10, 5 * 60_000);
  }

  /**
   * Ejecuta `fn` protegido por la ventana. Si otra ejecución con la misma
   * `clave` está EN VUELO, o terminó hace menos de `ventanaMs`, lanza
   * LimitacionConocida sin llamar a `fn`. Al terminar con éxito refresca la
   * reserva; al fallar, la libera SÓLO si el error está marcado seguro (un fallo
   * ambiguo la mantiene, pero ya no en vuelo, para que la ventana la venza).
   */
  async ejecutar<T>(clave: string, mensajeDuplicado: string, fn: () => Promise<T>): Promise<T> {
    const ahora = Date.now();
    for (const [k, v] of this.enCurso) {
      const vencida = v.enVuelo ? ahora - v.ts > this.topeEnVueloMs : ahora - v.ts > this.ventanaMs;
      if (vencida) this.enCurso.delete(k);
    }
    if (this.enCurso.has(clave)) throw new LimitacionConocida(mensajeDuplicado);
    // Reserva SÍNCRONA: entre este set y el await no hay suspensión, así que un
    // segundo request concurrente ya la encuentra.
    this.enCurso.set(clave, { ts: ahora, enVuelo: true });
    try {
      const r = await fn();
      this.enCurso.set(clave, { ts: Date.now(), enVuelo: false });
      return r;
    } catch (e) {
      if (esSeguroDeLiberar(e)) this.enCurso.delete(clave);
      else this.enCurso.set(clave, { ts: Date.now(), enVuelo: false });
      throw e;
    }
  }

  /** @internal Sólo para tests. */
  _reset(): void { this.enCurso.clear(); }
}
