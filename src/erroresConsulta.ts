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
  // `codigo` en vez del error original como `cause`. Guardar la causa cruda
  // parece gratis y no lo es: el error de `execFileSync` empieza con
  // "Command failed: " y el comando COMPLETO con argumentos, que en algunos
  // caminos lleva datos sensibles, y `src/rest/auditoria.ts` loguea el error
  // entero con console.error.
  //
  // Marcar `cause` como no enumerable NO alcanza — verificado en Node: tanto
  // `util.inspect` como `console.error` imprimen `[cause]` igual, porque el
  // formateador de Error la trata como caso especial en vez de recorrer sólo
  // las props enumerables. Así que la causa no se guarda: se conserva sólo el
  // código, que identifica el fallo sin arrastrar el comando.
  readonly codigo?: string;

  constructor(mensaje: string, opciones?: { codigo?: string }) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = opciones?.codigo;
  }
}

// El SII confirmó que el dato pedido no existe (no que falló al buscarlo). Se
// distingue del resto de las limitaciones porque el adaptador REST la traduce a
// un código propio del contrato, `NO_ENCONTRADO`: sin eso, un identificador
// equivocado —permanente— llega al tenant con los mismos bytes que una caída
// del portal —transitoria—, y el tenant reintenta en loop lo que nunca va a
// funcionar.
export class RecursoNoEncontrado extends LimitacionConocida {}
