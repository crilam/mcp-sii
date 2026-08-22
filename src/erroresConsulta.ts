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
  // `codigo` en vez del error original como `cause`: identifica el fallo sin
  // arrastrar el comando de `execFileSync`, que viaja en el mensaje del error
  // original y termina en el log central. El razonamiento completo, incluido por
  // qué marcar `cause` como no enumerable no alcanza, está en el comentario de
  // `ErrorDeBrowser` en src/browser.ts.
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
