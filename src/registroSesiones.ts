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
  constructor(private crear: (rut: string) => T | Promise<T>) {}

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

  // Descarta la sesión cacheada de un RUT: la próxima llamada a ejecutar()
  // vuelve a pasar por `crear`, con la credencial que tenga el proveedor en
  // ese momento.
  olvidar(rut: string): void {
    this.instancias.delete(normalizar(rut));
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
  // Siempre crea sesión NUEVA (nunca reusa `instancias`): un pase único no
  // debe heredar el cookie jar/estado de una sesión anterior de ese RUT.
  async ejecutarPassThrough<R>(
    rut: string,
    preparar: () => void,
    finalizar: () => void,
    fn: (sesion: T) => Promise<R>
  ): Promise<R> {
    const clave = normalizar(rut);
    return this.cola.ejecutar(clave, async () => {
      preparar();
      try {
        const sesion = await this.crear(clave);
        return await fn(sesion);
      } finally {
        this.instancias.delete(clave);
        finalizar();
      }
    });
  }
}
