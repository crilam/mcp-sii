import { ColaPorClave } from './colaPorClave';
import { normalizar } from './credenciales';

// Lo mínimo que un adaptador necesita de un registro de sesiones: correr algo
// contra la sesión de un RUT. RegistroSesiones lo implementa; el adaptador
// REST arma además un ejecutor "de un solo uso" por request (ver
// ejecutarPassThrough) que también cumple esta interfaz, para que
// src/core/*.ts pueda tratarlos igual sin saber cuál de los dos es.
export interface EjecutorSesion<T> {
  ejecutar<R>(rut: string, fn: (sesion: T) => Promise<R>): Promise<R>;
}

// Registro de sesiones del SII por credencial (RUT de la persona autenticada).
//
// Convierte el proceso de una sola credencial en uno multi-tenant: cada RUT
// tiene su propia sesión —su propio cookie jar, su propia empresa activa— y sus
// operaciones se serializan entre sí (el SII bloquea sesiones simultáneas del
// mismo RUT), mientras que RUTs distintos corren en paralelo porque no comparten
// nada en el SII.
//
// La sesión se crea con una factory inyectada: el registro no sabe cómo se
// arma una sesión ni de dónde salen las credenciales (env hoy, Secrets Manager
// mañana). Sólo garantiza "una por RUT, serializada por RUT".
export class RegistroSesiones<T> implements EjecutorSesion<T> {
  private instancias = new Map<string, T>();
  private cola = new ColaPorClave();

  // La factory puede ser asíncrona: cargar la credencial de un RUT es un GET a
  // Secrets Manager en producción. No hace falta protegerla de doble creación a
  // mano —`ejecutar` corre dentro de la cola por RUT, así que dos llamadas del
  // mismo RUT no ven la caché vacía a la vez—.
  // `destruir` libera los recursos de una sesión que se desaloja (el contexto
  // del navegador, que es un proceso y un perfil en disco). Sin esto, en un
  // servidor de larga vida cada RUT y cada pase único dejan un contexto abierto
  // que nadie cierra nunca. Es opcional para no obligar a los tests a inventar
  // uno.
  constructor(
    private crear: (rut: string) => T | Promise<T>,
    private destruir?: (sesion: T) => void | Promise<void>
  ) {}

  // Desaloja la sesión cacheada de un RUT liberando sus recursos. Se usa desde
  // los dos caminos que la descartan (`olvidar` y el final de un pase único),
  // para que ninguno se olvide de cerrar.
  private desalojar(clave: string): void {
    const sesion = this.instancias.get(clave);
    this.instancias.delete(clave);
    if (sesion) this.destruirSeguro(sesion);
  }

  // Se traga cualquier fallo, sincrónico o asíncrono: cerrar el contexto es
  // limpieza y no puede tumbar la operación que ya terminó ni el logout que el
  // usuario pidió. El `.catch` no es redundante con el try: si alguien inyecta
  // un `destruir` async, su rechazo no pasa por el try y quedaría como unhandled
  // rejection.
  private destruirSeguro(sesion: T): void {
    if (!this.destruir) return;
    try {
      void Promise.resolve(this.destruir(sesion)).catch(() => {});
    } catch {
      // Falló de forma sincrónica.
    }
  }

  async ejecutar<R>(rut: string, fn: (sesion: T) => Promise<R>): Promise<R> {
    // Se normaliza acá, en el único punto de entrada al registro y a la cola:
    // así "12.345.678-9" y "123456789" indexan la misma sesión y se serializan
    // entre sí, sin depender de que cada tool normalice antes de llamar.
    const clave = normalizar(rut);
    return this.cola.ejecutar(clave, async () => fn(await this.sesionDe(clave)));
  }

  private async sesionDe(rut: string): Promise<T> {
    let sesion = this.instancias.get(rut);
    if (!sesion) {
      // Se espera ANTES de cachear: guardar la promesa haría que `fn` reciba una
      // promesa en vez de la sesión resuelta.
      sesion = await this.crear(rut);
      this.instancias.set(rut, sesion);
    }
    return sesion;
  }

  // Descarta la sesión cacheada de un RUT y libera sus recursos: la próxima
  // llamada a ejecutar() vuelve a pasar por `crear`, con la credencial que tenga
  // el proveedor en ese momento.
  //
  // PRECONDICIÓN: corre FUERA de la cola por RUT, así que quien llame tiene que
  // saber que no hay una operación de ese RUT en curso — si la hubiera, le
  // cerraría el contexto por debajo. Hoy el único llamador en producción es
  // `sii_cerrar_sesion`, que lo invoca después de que su propio `logout()`
  // terminó.
  //
  // Nota de alcance: mientras nadie más lo llame, las sesiones CACHEADAS de un
  // proceso de larga vida no se desalojan solas. No hay TTL ni tope: un RUT que
  // abrió sesión y nunca la cerró mantiene su contexto vivo. Aceptable hoy
  // porque el adaptador REST usa pass-through (que sí cierra) y el servidor MCP
  // atiende un puñado de RUTs por proceso, pero es el próximo límite a mirar si
  // eso cambia.
  olvidar(rut: string): void {
    this.desalojar(normalizar(rut));
  }

  // Cierra la sesión de un RUT y la desaloja, TODO dentro del turno de la cola
  // de ese RUT. Es la vía correcta para "cerrar sesión": `olvidar()` sola corre
  // fuera de la cola, y desalojar ya no es sólo sacar una entrada de un Map —
  // cierra el proceso del navegador y borra su perfil del disco. Si otra
  // operación del mismo RUT estuviera encolada o en vuelo, le arrancaría el
  // contexto por debajo mientras lo usa.
  //
  // `cerrar` lo provee quien llama porque el registro es genérico y no sabe qué
  // significa cerrar una sesión (para SessionManager es `logout()`, o sea la
  // sesión del lado del SII).
  //
  // Si no hay sesión cacheada no se crea una para cerrarla: no habría nada que
  // cerrar y sólo se pagaría abrir un navegador al vacío.
  async cerrarYOlvidar(rut: string, cerrar: (sesion: T) => Promise<void>): Promise<void> {
    const clave = normalizar(rut);
    return this.cola.ejecutar(clave, async () => {
      const sesion = this.instancias.get(clave);
      if (!sesion) return;
      try {
        await cerrar(sesion);
      } finally {
        this.desalojar(clave);
      }
    });
  }

  // Para flujos de una sola pasada con credencial por request (validar-clave,
  // rutas REST pass-through): `preparar` (guardar la credencial), la creación
  // de la sesión, `fn`, y `finalizar` (borrar la credencial) corren TODOS
  // dentro del MISMO turno de la cola por RUT — no como pasos sueltos
  // alrededor de `ejecutar()`.
  //
  // Es imprescindible que sea así: `credenciales.guardar()`/`.borrar()` tocan
  // un Map compartido por fuera de la cola. Si dos requests concurrentes al
  // mismo RUT con clave DISTINTA hicieran guardar()-luego-ejecutar() como
  // pasos separados (como se hacía antes), la segunda `guardar()` podía pisar
  // la credencial de la primera ANTES de que la primera llegara a autenticar
  // — la primera terminaría autenticando con la clave de la segunda. Peor:
  // el `borrar()` de la que termina primero podía borrarle la credencial a la
  // que todavía espera turno en la cola. Encolar preparar+crear+fn+finalizar
  // como una sola unidad elimina la ventana: mientras el turno de un RUT está
  // en curso, ninguna otra llamada para ese mismo RUT puede leer ni tocar el
  // Map de credenciales de por medio.
  //
  // Siempre crea sesión NUEVA (nunca reusa `instancias`): un pase único no debe
  // heredar el cookie jar/estado de una sesión anterior de ese RUT. Para que eso
  // sea cierto de verdad, la factory tiene que darle también un CONTEXTO de
  // navegador propio — si dos sesiones del mismo RUT comparten contexto,
  // comparten cookies y la promesa de arriba es falsa (ver registroSesionesSii).
  async ejecutarPassThrough<R>(
    rut: string,
    preparar: () => void,
    finalizar: () => void,
    fn: (sesion: T) => Promise<R>
  ): Promise<R> {
    const clave = normalizar(rut);
    return this.cola.ejecutar(clave, async () => {
      preparar();
      // La sesión del pase NUNCA entra en `instancias`, así que hay que cerrarla
      // por referencia: un `desalojar(clave)` no la encontraría, y además podría
      // cerrarle el contexto a la sesión cacheada de ese mismo RUT, que es de
      // otra instancia y sigue en uso.
      let sesion: T | undefined;
      try {
        sesion = await this.crear(clave);
        return await fn(sesion);
      } finally {
        if (sesion) this.destruirSeguro(sesion);
        finalizar();
      }
    });
  }
}
