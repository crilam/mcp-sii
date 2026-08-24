import { SiiHttpClient } from '../http';
import { RequiereCertificado, SessionManager } from '../session';
import { LimitacionConocida, RecursoNoEncontrado } from '../erroresConsulta';

export interface MesBhe {
  mes: number;
  honorarioBruto: number;
  retencionTerceros: number;
  retencionContribuyente: number;
  folioInicial: number | null;
  folioFinal: number | null;
  emisionesVigentes: number;
  emisionesAnuladas: number;
}

export interface InformeAnualBhe {
  anio: number;
  rut: string;
  nombreContribuyente: string;
  meses: MesBhe[];
  folioInicial: number | null;
  folioFinal: number | null;
}

// La contraparte de una boleta emitida es el receptor; la de una recibida, el
// emisor. Nombrar los dos casos "receptor" mentía sobre qué representa el dato
// en las recibidas, así que el campo dice de quién se trata en cada caso.
export type RolContraparte = 'receptor' | 'emisor';

export interface BoletaBhe {
  folio: number;
  // Identificador que el SII exige para pedir el PDF de la boleta: el folio NO
  // sirve para eso. Son ~20 caracteres que empiezan con el RUT del emisor
  // (ej. "111111110000048F99ED"). Es el mismo valor que apigateway llama
  // `codigo` en /bhe/emitidas/pdf/{codigo}. Cadena vacía si el SII no lo
  // informó: es opaco, así que no se valida su forma ni su largo (las capturas
  // muestran largos distintos entre emitidas y recibidas).
  codigoBarras: string;
  fecha: string;
  contraparteRol: RolContraparte;
  contraparteRut: string;
  contraparteNombre: string;
  // Fecha en que se EMITIÓ la boleta, que puede diferir de la fecha del
  // documento (`fecha`): el SII las informa por separado y apigateway también
  // (`fecha` y `fecha_emision`). Vacía en recibidas, donde el CGI no la trae.
  fechaEmision: string;
  // Mail al que el emisor envió la boleta. Vacío si no se envió por mail o si el
  // informe no lo trae (recibidas).
  emailEnvio: string;
  // Si la contraparte es sociedad profesional. Cambia el tratamiento tributario,
  // así que se expone en vez de descartarlo: el CGI ya lo manda.
  sociedadProfesional: boolean;
  honorarioBruto: number;
  // El informe de recibidas no trae la retención del emisor (el receptor no la
  // ve). null es "el SII no lo informa", distinto de un cero que sí informó.
  retencionEmisor: number | null;
  retencionReceptor: number;
  totalLiquido: number;
  anulada: boolean;
}

const BASE = 'https://loa.sii.cl/cgi_IMT';
const CGI_ANUAL = `${BASE}/TMBCOC_InformeAnualBhe.cgi`;
const CGI_MENSUAL = `${BASE}/TMBCOC_InformeMensualBhe.cgi`;
const CGI_MENSUAL_REC = `${BASE}/TMBCOC_InformeMensualBheRec.cgi`;
// Ojo con el prefijo: los informes son TMBCO*C*_, el PDF es TMBCO*T*_. La URL
// sale del propio JS del informe mensual, que arma este link por cada fila.
const CGI_PDF = `${BASE}/TMBCOT_ConsultaBoletaPdf.cgi`;

// Aviso con el que el portal responde cuando el código de barras no le
// corresponde a ninguna boleta del RUT, y cuántos bytes del cuerpo se miran
// buscándolo. Van juntos a propósito: la respuesta observada son 1403 bytes,
// pero si el SII alguna vez mete el aviso detrás de un header o un JS más
// largo, el corte lo deja fuera y el fallo permanente vuelve a tratarse como
// transitorio. Quien mueva uno tiene que ver el otro.
const AVISO_BOLETA_INEXISTENTE = /No existe la boleta de honorarios/i;
const BYTES_A_INSPECCIONAR = 4_000;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
               'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// El CGI devuelve la tabla vacía y escribe los datos en variables JavaScript
// que el navegador renderiza con document.write. El parser va sobre el fuente.
const XML_VALUE = /xml_values\['(\w+)'\]\s*=\s*"([^"]*)"/g;

// El CGI pagina de a 100 filas: `MAXFILAS=100` y `tot_pag = Math.ceil(max/100)`
// en la propia respuesta. Ver ESQUEMAS/comentario en parseBoletas.
const MAX_FILAS_POR_PAGINA = 100;

// Emitidas y recibidas NO comparten esquema: el CGI de recibidas usa otros
// nombres de campo (verificado contra el portal). Parsear las recibidas con los
// nombres de emitidas devolvía cada boleta con RUT "-" y nombre vacío, sin
// lanzar nada. Cada informe declara sus claves acá.
interface EsquemaBoletas {
  rol: RolContraparte;
  rut: string;
  dv: string;
  nombre: string;
  // El CGI de recibidas no emite fechaemision_N; la fecha de la boleta viene
  // en fecha_boleta_N, que emitidas también trae.
  fecha: string;
  // Ausente en recibidas: el receptor no ve la retención que declaró el emisor.
  retencionEmisor: string | null;
  // Campos que sólo emite el informe de EMITIDAS. `null` significa "este informe
  // no lo trae", que es distinto de "vino vacío": sin la distinción se leería
  // una clave inexistente y el campo saldría vacío sin que nadie note que el
  // informe cambió de forma.
  fechaEmision: string | null;
  emailEnvio: string | null;
}

const ESQUEMA_EMITIDAS: EsquemaBoletas = {
  rol: 'receptor',
  rut: 'rutreceptor',
  dv: 'dvreceptor',
  nombre: 'nombrereceptor',
  fecha: 'fechaemision',
  retencionEmisor: 'retencion_emisor',
  fechaEmision: 'fechaemision',
  emailEnvio: 'email_envio',
};

const ESQUEMA_RECIBIDAS: EsquemaBoletas = {
  rol: 'emisor',
  rut: 'rutemisor',
  dv: 'dvemisor',
  // Con guión bajo, a diferencia de `nombrereceptor` en emitidas.
  nombre: 'nombre_emisor',
  fecha: 'fecha_boleta',
  retencionEmisor: null,
  fechaEmision: null,
  emailEnvio: null,
};

// Entidades HTML que el SII emite en razones sociales (respuesta ISO-8859-1).
// Se resuelven a mano para no agregar dependencias; las numéricas van aparte.
const ENTIDADES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
  ordm: 'º', ordf: 'ª', deg: '°',
};

// LimitacionConocida y RecursoNoEncontrado viven en src/erroresConsulta.ts: el
// transporte HTTP también tiene que lanzarlas, y no puede depender de un scraper
// de dominio. Se importan de ahí, sin re-exportar desde acá.

export class BheScraper {
  constructor(
    private http: SiiHttpClient,
    private session: SessionManager
  ) {}

  // La causa más común de una respuesta que no parece un informe es una sesión
  // del SII ya caducada. Sin invalidarla, `autenticadoHasta` la sigue dando por
  // buena durante dos horas y cada reintento repite el mismo fallo hasta
  // reiniciar el proceso — así que el consejo "reintentá" era el único que no
  // podía funcionar. Mismo patrón que BienesRaicesScraper. Vive acá, envolviendo
  // a los dos informes, para no duplicar el reintento en cada método.
  private async conSesionFresca<T>(intento: () => Promise<T>): Promise<T> {
    try {
      return await intento();
    } catch (e) {
      // Un límite que ya conocemos no se arregla reautenticando: reintentarlo
      // sólo gastaría otra consulta para volver a fallar igual.
      if (e instanceof LimitacionConocida) throw e;
      // Misma razón: la estrategia de autenticación no cambia entre intentos, así
      // que reintentar sólo abriría una segunda sesión en el SII para volver a
      // fallar igual. Es defensa en profundidad — con el chequeo previo de
      // `intentar*` este error ya no debería llegar acá — pero si algún camino
      // futuro vuelve a pedir el cookie jar sin preguntar antes, el costo tiene
      // que quedar en una sesión, no en dos.
      if (e instanceof RequiereCertificado) throw e;
      this.session.invalidate();
      return intento();
    }
  }

  // Estos informes se sirven por HTTP, y el cliente HTTP sólo funciona si la
  // sesión puede entregarle el cookie jar. Si no puede, la consulta está
  // condenada desde el principio: preguntarlo ANTES de `authenticateOnly()`
  // evita abrir en el SII una sesión que después no se va a poder usar, y que
  // igual cuenta para el bloqueo por sesiones simultáneas. El scraper no decide
  // nada sobre estrategias de autenticación — sólo consulta a su dueña.
  private assertConsultaHttpPosible(): void {
    this.session.assertPuedeEntregarCookieJar();
  }

  async informeAnual(anio: number): Promise<InformeAnualBhe> {
    return this.conSesionFresca(() => this.intentarInformeAnual(anio));
  }

  private async intentarInformeAnual(anio: number): Promise<InformeAnualBhe> {
    this.assertConsultaHttpPosible();
    // No requiere seleccionar empresa: la BHE es de la persona natural.
    await this.session.authenticateOnly();
    const { rut, dv } = this.session.identidad();
    // El formulario del portal manda estos dos campos ocultos en cada consulta.
    // La spike los envió y funcionó; omitirlos no está verificado.
    const html = await this.http.get(CGI_ANUAL, {
      rut_arrastre: rut,
      dv_arrastre: dv,
      cbanoinformeanual: String(anio),
    });

    const values = this.parseXmlValues(html);

    // Una respuesta sin la cabecera del informe no es un año vacío: es una
    // sesión caída, un error del portal o un rediseño. Confundirlos haría que
    // el fallo se reporte como "no tenés boletas".
    if (!values['anio_consulta']) {
      throw new Error(
        'El SII no devolvió un informe de boletas de honorarios. La sesión pudo expirar; reintentá.'
      );
    }

    const meses = MESES
      .map((prefijo, i) => this.parseMes(values, prefijo, i + 1))
      .filter((m): m is MesBhe => m !== null);

    return {
      anio: this.toInt(values['anio_consulta']) ?? anio,
      rut: `${values['rut_arrastre'] ?? ''}-${values['dv_arrastre'] ?? ''}`,
      nombreContribuyente: (values['nombre_contribuyente'] ?? '').trim(),
      meses,
      folioInicial: this.toInt(values['tot4']),
      folioFinal: this.toInt(values['tot5']),
    };
  }

  async informeMensual(
    anio: number,
    mes: number,
    recibidas = false
  ): Promise<BoletaBhe[]> {
    return this.conSesionFresca(() => this.intentarInformeMensual(anio, mes, recibidas));
  }

  private async intentarInformeMensual(
    anio: number,
    mes: number,
    recibidas: boolean
  ): Promise<BoletaBhe[]> {
    this.assertConsultaHttpPosible();
    // No requiere seleccionar empresa: la BHE es de la persona natural.
    await this.session.authenticateOnly();

    // Primera página: además de sus filas, trae el total del mes, que es lo que
    // dice cuántas páginas hay.
    const primera = await this.pedirPagina(anio, mes, recibidas, 0);
    const total = this.toInt(primera.values['total_boletas']) ?? 0;
    const esquema = recibidas ? ESQUEMA_RECIBIDAS : ESQUEMA_EMITIDAS;
    const boletas = this.parseBoletas(primera.html, esquema);

    // Cuántas páginas hay y cómo se piden NO se adivina: lo declara el propio JS
    // del informe, que arma su paginador con
    //   tot_pag = Math.ceil(max/100)   y   listar(i) para i en [0, tot_pag)
    // poniendo `i` en `pagina_solicitada`. O sea que el índice es 0-based y la
    // cuenta sale del total del mes. (Antes esto era un error explícito: el
    // comentario decía que sin una captura de un mes con más de 100 boletas no
    // se podía saber qué valor pide la página 2. Se podía: está escrito en la
    // respuesta.)
    const totalPaginas = Math.ceil(total / MAX_FILAS_POR_PAGINA);
    for (let pagina = 1; pagina < totalPaginas; pagina++) {
      const { html } = await this.pedirPagina(anio, mes, recibidas, pagina);
      boletas.push(...this.parseBoletas(html, esquema));
    }

    // Chequeo de integridad: si el SII dijo N y juntamos otra cantidad, algo se
    // perdió o se duplicó, y un listado incompleto presentado como el mes
    // completo entra al motor contable del consumidor como un total real. Es el
    // modo de falla silencioso que el error explícito anterior evitaba, así que
    // no se cambia por confianza: se verifica.
    if (boletas.length !== total) {
      throw new Error(
        `El SII informó ${total} boletas para ${String(mes).padStart(2, '0')}/${anio} ` +
        `pero se recuperaron ${boletas.length} en ${totalPaginas} página(s). ` +
        'No se devuelve un listado incompleto; reintentá.'
      );
    }

    return boletas;
  }

  private async pedirPagina(
    anio: number,
    mes: number,
    recibidas: boolean,
    pagina: number
  ): Promise<{ html: string; values: Record<string, string> }> {
    const { rut, dv } = this.session.identidad();
    const html = await this.http.postForm(
      recibidas ? CGI_MENSUAL_REC : CGI_MENSUAL,
      {
        rut_arrastre: rut,
        dv_arrastre: dv,
        // Sin este campo el CGI responde el error TMB020a en vez del informe.
        // Es 0-based (ver el paginador del propio informe).
        pagina_solicitada: String(pagina),
        // El formulario del portal manda el mes con dos digitos.
        cbmesinformemensual: String(mes).padStart(2, '0'),
        cbanoinformemensual: String(anio),
      }
    );

    const values = this.parseXmlValues(html);
    if (!values['anio_consulta']) {
      throw new Error(
        'El SII no devolvió un informe de boletas de honorarios. La sesión pudo expirar; reintentá.'
      );
    }
    return { html, values };
  }

  // Descarga el PDF de UNA boleta. La clave es el `codigoBarras` que entrega
  // `informeMensual`, no el folio: el CGI no acepta el folio.
  async pdfBoleta(codigoBarras: string, recibida = false): Promise<Buffer> {
    // La validación va FUERA de `conSesionFresca`, a propósito. Adentro, este
    // error no sería ni LimitacionConocida ni RequiereCertificado, así que el
    // wrapper invalidaría la sesión y reintentaría: un `codigo_barras` vacío
    // mandado por un tenant tiraría abajo una sesión del SII que estaba sana y
    // forzaría un re-login en la consulta siguiente. Un input inválido del
    // cliente no debe degradar el estado del proceso.
    //
    // Un código vacío llega cuando el informe no lo trajo (ver BoletaBhe).
    if (!codigoBarras.trim()) {
      throw new Error(
        'Falta el código de barras de la boleta. Es el campo codigoBarras que ' +
        'devuelve el listado del mes, y es lo único que el SII acepta para ' +
        'identificar la boleta al pedir el PDF (el folio no sirve).'
      );
    }

    return this.conSesionFresca(() => this.intentarPdfBoleta(codigoBarras, recibida));
  }

  private async intentarPdfBoleta(codigoBarras: string, recibida: boolean): Promise<Buffer> {
    this.assertConsultaHttpPosible();
    await this.session.authenticateOnly();

    const { contenido, contentType } = await this.http.getBinario(CGI_PDF, {
      txt_codigobarras: codigoBarras.trim(),
      veroriginal: 'si',
      // `PROPIOS` es el valor que el informe de emitidas pone en el link del
      // PDF. Los dos valores están verificados en vivo contra el portal (una
      // emitida y una recibida, PDF completo en ambos casos). Un `origen`
      // equivocado no falla en silencio: el CGI responde el HTML del portal, y
      // el chequeo de Content-Type de abajo lo rechaza.
      origen: recibida ? 'RECIBIDOS' : 'PROPIOS',
      enviar: 'si',
    });

    // El CGI responde 200 con el HTML del formulario de login cuando la sesión
    // no le sirve, así que el status no distingue nada: lo que separa un PDF de
    // un fallo es el Content-Type. Sin este chequeo, el error viajaría como un
    // "PDF" de 17 KB que ningún lector abre.
    if (!/application\/pdf/i.test(contentType)) {
      // Se corta el BUFFER antes de decodificar: `toString()` sobre la
      // respuesta completa (hasta MAX_RESPUESTA_BYTES) para después quedarse
      // con 4 KB es trabajo tirado, y acá el cuerpo puede ser un PDF entero.
      const cuerpo = contenido.subarray(0, BYTES_A_INSPECCIONAR).toString('latin1');
      // El código lo manda el tenant: se trunca para no volcar una cadena
      // arbitrariamente larga en el log central.
      const detalle = `El SII no devolvió un PDF para la boleta ` +
        `${codigoBarras.slice(0, 40)} ` +
        `(respondió "${contentType || 'sin Content-Type'}"): `;

      // Sólo se afirma "el código no existe" cuando el portal lo dice con estas
      // palabras — verificado en vivo: ante un código inexistente, ajeno o
      // basura responde 1403 bytes titulados "INFORMACION AL CONTRIBUYENTE" con
      // ese texto. Eso NO se arregla reautenticando, y `conSesionFresca`
      // reintenta cualquier cosa que no sea LimitacionConocida, así que sin
      // esta rama el wrapper gastaría un re-login y otra consulta para fallar
      // igual.
      //
      // La clasificación es por evidencia positiva, no por descarte: una página
      // de mantención, un 500 del CGI o un login con el título cambiado también
      // llegan acá, y esos SÍ son transitorios. Marcarlos como permanentes por
      // no reconocerlos le negaría el reintento a un fallo que se resuelve
      // solo, con una causa inventada encima.
      if (AVISO_BOLETA_INEXISTENTE.test(cuerpo)) {
        throw new RecursoNoEncontrado(
          `${detalle}el SII informa que no existe una boleta con ese código de ` +
          'barras. Además del código en sí, revisá que el flag de recibida sea ' +
          `el correcto: se pidió como ${recibida ? 'recibida' : 'emitida'}, y ` +
          'pedir una boleta con el origen equivocado devuelve exactamente esta ' +
          'respuesta. Reintentar no ayuda.'
        );
      }

      if (/<title>[^<]*Autenticaci/i.test(cuerpo)) {
        throw new Error(
          `${detalle}el SII devolvió el formulario de autenticación, así que la ` +
          'sesión expiró: reintentá.'
        );
      }

      // Ni PDF, ni "no existe", ni login: no se sabe qué pasó, así que no se
      // nombra una causa y se deja reintentar.
      //
      // Se incluye el título de la página en el mensaje como señal temprana: la
      // detección de "no existe" depende de un texto en español del portal, y si
      // el SII le cambia una palabra, ese fallo permanente vuelve a caer acá y a
      // reintentarse en loop. Ver un título "INFORMACION AL CONTRIBUYENTE" en
      // esta rama del log es exactamente el aviso de que el texto se movió.
      const titulo = /<title>([^<]{0,120})<\/title>/i.exec(cuerpo)?.[1]?.trim();
      throw new Error(
        `${detalle}el portal respondió algo inesperado` +
        `${titulo ? ` (página "${titulo}")` : ''}. Puede ser una caída o una ` +
        'página de mantención del SII; reintentá.'
      );
    }

    // Un `application/pdf` de cero bytes pasa el chequeo de arriba pero no es
    // un documento: llegaría al tenant como un archivo vacío que su lector no
    // abre, sin ningún error de por medio. Reintentable a propósito — es el
    // síntoma de una descarga cortada, no de un dato que no existe.
    if (!contenido.length) {
      throw new Error(
        `El SII devolvió un PDF vacío para la boleta ${codigoBarras.slice(0, 40)}. ` +
        'La descarga se cortó; reintentá.'
      );
    }

    return contenido;
  }

  private parseXmlValues(html: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const m of html.matchAll(XML_VALUE)) {
      values[m[1]] = m[2];
    }
    return values;
  }

  // Un mes sin folios no tuvo actividad: sus claves vienen ausentes o vacías.
  private parseMes(
    values: Record<string, string>,
    prefijo: string,
    mes: number
  ): MesBhe | null {
    const folioInicial = this.toInt(values[`${prefijo}4`]);
    if (folioInicial === null) return null;

    return {
      mes,
      honorarioBruto: this.toInt(values[`${prefijo}1`]) ?? 0,
      retencionTerceros: this.toInt(values[`${prefijo}2`]) ?? 0,
      retencionContribuyente: this.toInt(values[`${prefijo}3`]) ?? 0,
      folioInicial,
      folioFinal: this.toInt(values[`${prefijo}5`]),
      emisionesVigentes: this.toInt(values[`${prefijo}6`]) ?? 0,
      emisionesAnuladas: this.toInt(values[`${prefijo}7`]) ?? 0,
    };
  }

  private toInt(text: string | undefined): number | null {
    if (!text) return null;
    // El SII usa el punto como separador de miles (se descarta junto con el
    // resto de caracteres no numéricos), pero el signo negativo se preserva
    // aparte: si alguna vez llega un valor negativo (ej. una corrección),
    // truncarlo a positivo corrompería el dato en silencio, sin lanzar ni
    // registrar nada. La asimetría entre "quitar puntos" y "conservar signo"
    // es deliberada.
    const negativo = text.trim().startsWith('-');
    const digits = text.replace(/[^\d]/g, '');
    if (!digits) return null;
    const valor = parseInt(digits, 10);
    return negativo ? -valor : valor;
  }

  // Las boletas no vienen en xml_values sino en arr_informe_mensual, con el
  // indice como sufijo de la clave. Varios nombres de campo ya contienen "_",
  // asi que el indice es el ultimo segmento, no el segundo.
  private parseArrInforme(html: string): Record<string, string> {
    const values: Record<string, string> = {};
    // El valor se toma hasta el fin de línea, no hasta el primer ";": una razón
    // social con entidades HTML ("SOC. GARC&Iacute;A &amp; CIA") lleva puntos y
    // coma adentro del literal, y cortar ahí devolvía una cadena sin comilla de
    // cierre que `desenvolver` no reconocía — el nombre desaparecía sin error.
    // Cada asignación del CGI ocupa una línea propia, así que la frontera segura
    // es el salto de línea y quien delimita el valor son las comillas.
    const re = /arr_informe_mensual\['([^']+)'\]\s*=\s*([^\n\r]*)/g;
    for (const m of html.matchAll(re)) {
      values[m[1]] = this.desenvolver(m[2]);
    }
    return values;
  }

  // Los montos llegan como formatMiles("145000",'.'), no como string pelado.
  private desenvolver(expr: string): string {
    const conFormato = expr.match(/formatMiles\(\s*"([^"]*)"/);
    if (conFormato) return conFormato[1];
    const literal = expr.match(/"([^"]*)"/);
    return literal ? this.decodificarEntidades(literal[1]) : '';
  }

  // El SII escapa las razones sociales como entidades HTML porque el valor
  // termina en un document.write. Devolverlas crudas expone "GARC&Iacute;A" al
  // usuario, así que se resuelven acá (sin dependencias: tabla propia para las
  // nombradas que emite el portal, y cálculo directo para las numéricas).
  private decodificarEntidades(texto: string): string {
    if (!texto.includes('&')) return texto;
    return texto.replace(/&(#\d+|#[xX][0-9a-fA-F]+|\w+);/g, (entidad, cuerpo: string) => {
      if (cuerpo.startsWith('#')) {
        const codigo = cuerpo[1] === 'x' || cuerpo[1] === 'X'
          ? parseInt(cuerpo.slice(2), 16)
          : parseInt(cuerpo.slice(1), 10);
        return Number.isFinite(codigo) ? String.fromCodePoint(codigo) : entidad;
      }
      // Una entidad desconocida se deja tal cual: inventar un reemplazo
      // corrompería el nombre en silencio, que es el fallo que estamos cerrando.
      return ENTIDADES[cuerpo] ?? entidad;
    });
  }

  private parseBoletas(html: string, esquema: EsquemaBoletas): BoletaBhe[] {
    const arr = this.parseArrInforme(html);
    const boletas: BoletaBhe[] = [];

    // `CantidadFilas` es la cantidad de filas de ESTA página, y es lo correcto
    // para iterar. Antes se iteraba hasta `total_boletas`, que es el total del
    // MES: con más de una página los índices se pasaban del final (las claves de
    // `arr_informe_mensual` se numeran 1..N dentro de cada respuesta, no
    // globalmente) y las filas inexistentes se descartaban en silencio.
    const filas = this.cantidadFilas(html);

    for (let i = 1; i <= filas; i++) {
      const folio = this.toInt(arr[`nroboleta_${i}`]);
      // Un indice sin folio significa que el SII devolvio menos filas de las
      // que anuncio: se omite en vez de inventar una boleta vacia.
      if (folio === null) continue;

      const estado = (arr[`estado_${i}`] ?? '').trim();
      const fechaAnulacion = (arr[`fechaanulacion_${i}`] ?? '').trim();
      // El CGI lo manda como "SI"/"NO". Se compara contra "SI" y no se niega
      // "NO": si algún día llega vacío o con otro valor, "no es sociedad
      // profesional" es la lectura conservadora.
      const socProfesional = (arr[`es_soc_profesional_${i}`] ?? '').trim().toUpperCase();

      boletas.push({
        folio,
        codigoBarras: (arr[`codigobarras_${i}`] ?? '').trim(),
        fecha: (arr[`${esquema.fecha}_${i}`] ?? '').trim(),
        // Cadena vacía cuando el informe no trae el campo (recibidas): distinto
        // de "vino vacío", pero el consumidor no puede hacer nada distinto con
        // esa diferencia, así que no se inventa un tercer estado.
        fechaEmision: esquema.fechaEmision === null
          ? ''
          : (arr[`${esquema.fechaEmision}_${i}`] ?? '').trim(),
        emailEnvio: esquema.emailEnvio === null
          ? ''
          : (arr[`${esquema.emailEnvio}_${i}`] ?? '').trim(),
        sociedadProfesional: socProfesional === 'SI',
        contraparteRol: esquema.rol,
        contraparteRut: `${arr[`${esquema.rut}_${i}`] ?? ''}-${arr[`${esquema.dv}_${i}`] ?? ''}`,
        contraparteNombre: (arr[`${esquema.nombre}_${i}`] ?? '').trim(),
        honorarioBruto: this.toInt(arr[`totalhonorarios_${i}`]) ?? 0,
        retencionEmisor: esquema.retencionEmisor === null
          ? null
          : this.toInt(arr[`${esquema.retencionEmisor}_${i}`]) ?? 0,
        retencionReceptor: this.toInt(arr[`retencion_receptor_${i}`]) ?? 0,
        totalLiquido: this.toInt(arr[`honorariosliquidos_${i}`]) ?? 0,
        // Solo el caso vigente esta verificado contra el portal: las boletas
        // capturadas traen estado "N" y fecha de anulacion vacia. El valor que
        // usa el SII para una boleta anulada no se confirmo, asi que se miran
        // las dos senales en vez de comparar contra una constante inventada.
        anulada: (estado !== '' && estado !== 'N') || fechaAnulacion !== '',
      });
    }

    return boletas;
  }

  // Cantidad de filas de la página, que el CGI declara en su JS como
  // `CantidadFilas=N;` (fuera de `xml_values`, por eso tiene su propio parser).
  private cantidadFilas(html: string): number {
    return this.toInt(/CantidadFilas\s*=\s*(\d+)/.exec(html)?.[1]) ?? 0;
  }
}
