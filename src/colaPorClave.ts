// Cola de exclusión mutua indexada por clave: operaciones con la misma clave se
// serializan; con claves distintas corren en paralelo.
//
// Existe para el bloqueo del SII, que es por RUT: dos sesiones simultáneas del
// mismo RUT se bloquean entre sí (01.01.190.500.720.27), pero RUTs distintos son
// independientes. Un candado global serializaría de más —haría esperar a
// contribuyentes que no compiten—; uno por clave serializa exactamente lo que el
// SII obliga a serializar y nada más.
export class ColaPorClave {
  // Una promesa encadenada por clave: cada operación espera a la anterior de su
  // misma clave. Claves distintas tienen cadenas distintas, así que no se tocan.
  private colas = new Map<string, Promise<void>>();

  async ejecutar<T>(clave: string, fn: () => Promise<T>): Promise<T> {
    const anterior = this.colas.get(clave) ?? Promise.resolve();

    let liberar!: () => void;
    const turno = new Promise<void>(resolve => { liberar = resolve; });
    // La cadena avanza con el turno pase lo que pase con la operación previa: un
    // rechazo no propagado dejaría el resto de la cola de esa clave sin correr.
    this.colas.set(clave, anterior.then(() => turno, () => turno));

    await anterior.catch(() => { /* el error es del llamador anterior */ });

    try {
      return await fn();
    } finally {
      liberar();
    }
  }
}
