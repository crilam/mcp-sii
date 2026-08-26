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

// El SII rechazó el login porque el RUT ya tiene demasiadas sesiones abiertas
// (código 01.01.<n>.500.720.27). NO es una limitación conocida ni un fallo de
// credenciales: la clave es correcta y el dato existe, sólo que hay que esperar.
//
// Tiene su propio tipo —y su propio código en el contrato REST— porque mezclarlo
// con el ERROR genérico le cuesta tiempo a quien integra. Reintentar es la
// respuesta correcta en los dos casos, así que el comportamiento no cambia; lo
// que cambia es lo que se le puede decir a la persona. Con ERROR sólo cabe
// "probá de nuevo en unos minutos"; con esto se le puede decir que hay otra
// consulta en curso sobre el mismo contribuyente, que es accionable: sabe que
// tiene otra pestaña abierta o que un colega está mirando el mismo caso.
//
// El caso que lo motivó: la sesión que integra Tributy persiguió dos veces un
// "timeout" que era en realidad otra cosa. Un error mal clasificado manda a
// buscar el problema al lugar equivocado.
//
// ALCANCE, para no prometer de más: hoy se detecta SÓLO en el login, que es
// donde el portal lo informa con su página de aviso. Si el bloqueo apareciera a
// mitad de una sesión ya abierta —un CGI devolviendo esa misma página en vez de
// los datos— sigue saliendo como el ERROR genérico. Cerrarlo pide relevar cómo
// se ve ese caso en cada CGI, que no está capturado; escribir la detección a
// ciegas daría falsos positivos sobre respuestas que no son ese bloqueo.
export class SesionesSimultaneas extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
  }
}

// El SII cortó por volumen de consultas: su portal responde una página con
// "Error 429: Se ha superado el límite". Es su rate limiting, no el nuestro.
//
// Tiene tipo y código propios por el mismo motivo que `SesionesSimultaneas`: con
// el ERROR genérico, un corte por volumen se lee como "el portal falló, reintentá
// ya", y reintentar de inmediato es exactamente lo que lo mantiene cortado. Con
// un código propio, quien integra sabe que tiene que ESPERAR — y quien opera sabe
// que el problema es de ritmo y no un bug.
//
// Se descubrió del peor modo posible: un relevamiento de este repo hizo más de
// doscientas llamadas al portal del RCV en pocos minutos y ese portal empezó a
// devolver 429 a TODO, incluidas las consultas de los tenants. Ver `ritmoSii.ts`,
// que existe para que no vuelva a pasar.
export class LimiteDeConsultasSii extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
  }
}
