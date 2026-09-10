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

// El selector de empresas del portal mipyme (`mipeSelEmpresa.cgi`) es un
// permiso a nivel de PERSONA, no de empresa: verificado contra el portal real
// con dos credenciales de la misma empresa. Con la clave de la EMPRESA el
// selector devuelve 0 empresas y cualquier lectura de esa empresa falla; con la
// clave de la PERSONA que la administra el selector devuelve las cinco que esa
// persona opera y el respaldo baja completo — la clave de la empresa es válida
// (otros servicios de este MCP responden bien con ella), así que el problema
// nunca fue la credencial ni la empresa pedida, sino QUIÉN autentica.
//
// Los identificadores de esa medición no van acá: este repositorio es público y
// `tests/anonimizacion.test.ts` los rechaza con razón. La medición se sostiene
// sin ellos.
//
// Antes de este tipo, `resolverEmpresa`/`parseEmpresas` (mipymeHttp.ts)
// lanzaban un `Error` pelado que el adaptador REST traducía a
// `{ok:false, error:'ERROR'}` SIN `detalle`: el tenant no podía diagnosticar el
// fallo, y como `ERROR` es el único código que este contrato trata como
// transitorio, la corrida diaria del ERP reintentaba para siempre un pedido
// que ninguna corrida futura iba a resolver. Sólo lo arregla una acción
// humana: autenticar con la credencial de alguien que sí tenga esa empresa en
// su selector del portal mipyme, o pedir ese permiso ahí.
//
// Hereda de LimitacionConocida por el mismo motivo que RecursoNoEncontrado: es
// determinística —el mismo request contra el mismo par (RUT autenticado,
// empresa pedida) falla siempre igual— y no una falla de sesión que valga la
// pena reautenticar.
//
// Cubre DOS subcasos con la misma acción de fondo pero distinto diagnóstico:
//  - el selector vino VACÍO (`SelectorEmpresasVacio`, ver más abajo): el RUT
//    autenticado no opera NINGUNA empresa en el portal.
//  - el selector trajo empresas, pero la pedida no está entre ellas
//    (este tipo): el RUT autenticado opera OTRAS empresas, no la pedida. El
//    mensaje va con la CANTIDAD de esas otras empresas, no con sus RUT: son
//    datos de terceros desde el punto de vista de quien preguntó por una
//    empresa puntual, y no hace falta exponerlos para que el mensaje sea
//    accionable.
export class EmpresaNoAutorizada extends LimitacionConocida {}

// El combo de `mipeSelEmpresa.cgi` no trajo ninguna opción. `parseEmpresas` ya
// rechazaba este caso con un `Error` genérico (ver su comentario: un combo
// vacío también puede ser el CGI devolviendo otra página —sesión caída, WAF,
// rediseño— y no necesariamente "este RUT no opera empresas"; esa ambigüedad
// de PARSEO no se resuelve acá y sigue vigente). Lo que cambia es la
// clasificación: en la práctica medida contra el portal real, este caso es
// justamente el permiso a nivel de persona descrito en `EmpresaNoAutorizada`
// —RUT de una empresa, no de quien la administra—, así que merece el mismo
// código propio y el mismo `detalle` accionable en vez de viajar como `ERROR`
// mudo. El mensaje deja constancia de la ambigüedad residual: si esto pasa por
// una caída de sesión y no por el permiso, reintentar SÍ podría andar, pero no
// hay forma de distinguir los dos casos sólo con el HTML del combo.
export class SelectorEmpresasVacio extends LimitacionConocida {}

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

// Hay demasiadas consultas esperando su turno contra el mismo portal público.
//
// Los indicadores se serializan en una cola de un solo turno, porque un barrido
// paralelo contra sii.cl es el patrón que ya bloqueó el RCV. El timeout de la
// bajada cubre la conexión, NO el tiempo en cola: con la cola sin tope, un
// consumidor que pide cincuenta años nuevos deja a los demás esperando minutos
// con la conexión HTTP abierta y sin error a la vista, que del lado del que
// integra es indistinguible de un servicio colgado.
//
// Rechazar rápido es preferible a hacer esperar sin decir nada: el consumidor
// recibe una respuesta inmediata y sabe que tiene que reintentar más tarde.
// El SII RECHAZÓ una escritura por una regla de negocio (RUT inválido, sin
// timbraje, documento en un estado que no admite el acto, etc.). No es un bug
// del servicio ni algo que se arregle reintentando igual: es una respuesta
// legítima del SII que el consumidor tiene que leer y corregir. Con el ERROR
// genérico saldría como 500 "reintentá", que es lo contrario de lo que hay que
// hacer. Lleva el mensaje del SII crudo.
export class EscrituraRechazadaPorSii extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
  }
}

export class ServicioOcupado extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = new.target.name;
  }
}

// El portal mipyme devolvió su PROPIA página de error interno («Error al
// contribuyente» + «Por el momento no se puede responder a sus
// requerimientos. Por favor, inténtelo más tarde») en vez de la tabla del
// historial que se pidió. Medido contra el SII real: `mipeAdminDocsRcp.cgi`
// respondió esta página para una empresa de alto volumen en una consulta sin
// filtros, y el parser de historial —que sólo sabía leer filas de `<tr>`— la
// interpretó como una tabla SIN filas, o sea "cero documentos". Un fallo
// transitorio del portal, reportado como un dato vacío legítimo: peor que un
// error, porque quien lo consume concluye que no hay nada que descargar.
//
// NO es `LimitacionConocida`: esa familia significa "el SII confirmó un
// límite/dato y no lo arregla reintentar" (de ahí que el tercer nivel de
// troceo reaccione trocheando más fino). Acá el propio mensaje del portal
// pide reintentar más tarde — es exactamente lo opuesto, y tratarlo como una
// limitación conocida llevaría a trocear un día que no tiene nada que
// trocear: el problema no es cuántos documentos hay, es que el portal no
// contestó.
//
// `codigo` lleva el `CODIGO: NN.NN.NNN.NN.NNN.NN` que cita el aviso, sólo para
// mostrarlo en el mensaje (es lo que el SII pide dar en su mesa de ayuda). NO
// participa de la detección: esos octetos parecen llevar datos de sesión o de
// servidor y van a variar entre corridas, así que la detección se apoya en el
// título y la frase fija del aviso.
export class PortalSiiNoDisponible extends Error {
  readonly codigo?: string;

  constructor(mensaje: string, opciones?: { codigo?: string }) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = opciones?.codigo;
  }
}
