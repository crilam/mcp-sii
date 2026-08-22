// Fallo que no depende de la sesión, sino de un límite que ya conocemos: el
// dato pedido no existe, o la respuesta no cabe en lo que este cliente sabe
// leer. Quien reintenta consultas (`conSesionFresca` en los scrapers) lo
// distingue para NO reautenticar: reintentarlo gastaría una sesión del SII y
// otra consulta para volver a fallar igual.
//
// Vive en su propio módulo, y no en el scraper que la usa, porque el transporte
// HTTP también necesita lanzarla (una respuesta que excede el buffer) y no
// puede depender de un scraper de dominio.
export class LimitacionConocida extends Error {
  // Constructor explícito para aceptar `{ cause }`: los `lib` de TypeScript
  // configurados en este proyecto no incluyen la firma de dos argumentos de
  // Error, y perder la causa deja el fallo original sin rastro en el log.
  constructor(mensaje: string, opciones?: { cause?: unknown }) {
    super(mensaje);
    this.name = 'LimitacionConocida';
    if (opciones && 'cause' in opciones) {
      // No enumerable: `console.error(err)` imprime las props propias, y la
      // causa de un execFileSync trae el comando completo con sus argumentos.
      Object.defineProperty(this, 'cause', {
        value: opciones.cause, enumerable: false, writable: true, configurable: true,
      });
    }
  }
}
