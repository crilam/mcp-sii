import { ColaPorClave } from './colaPorClave';
import { normalizar } from './credenciales';

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
export class RegistroSesiones<T> {
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
}
