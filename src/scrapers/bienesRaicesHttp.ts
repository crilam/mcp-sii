import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';
import { RecursoNoEncontrado } from '../erroresConsulta';
import { BienRaiz, BienesRaicesResult, ResumenBienesRaices } from './bienesRaices';

// Bienes raíces por la API de la SPA del portal, sin navegador.
//
// El portal `vica` es una aplicación Vue cuyo backend es REST/JSON plano bajo
// `https://www2.sii.cl/app/vica/{rut-dv}/v1/...`: sin sobre SDI, sin CGI. Las
// rutas salieron de su bundle (`index-*.js`, 3,2 MB) y las formas de respuesta
// de pedirlas con una sesión real; nada de acá se adivinó.
//
// Reemplaza al scraper de navegador (`bienesRaices.ts`) para el listado, que
// parseaba el snapshot de accesibilidad de Chromium: funcionaba, pero cada
// consulta levantaba un navegador y dependía de la cola virtual del portal. Las
// rutas nuevas —comunas, copropietarios, solicitudes, consulta por rol y
// certificados— sólo existen por esta vía.
const HOST = 'https://www2.sii.cl';
const ENTRADA = `${HOST}/vica/Menu/BienesRaices`;

// Constantes del certificado, con los valores que el bundle asigna a sus
// variables minificadas (`$K="1"`, `RK="1"`, `GK="1"`...). Son STRINGS porque así
// viajan en el body que arma la SPA; el backend rechaza el body si no coinciden.
const TIPO_DOCUMENTO = {
  avaluoSimple: '1',
  avaluoPropietario: '2',
  avaluoDetallado: '3',
  // 4 períodos anteriores, 5 antecedentes de tercero, 6 detalle catastral,
  // 7 antecedentes de tercero sin clave: existen, no se usan todavía.
} as const;
const TIPO_SOLICITANTE_CONTRIBUYENTE_AUTENTICADO = '1';
// 1=ver, 2=mail, 3=descargar, 4=masiva. "Ver" es el flujo que devuelve el PDF
// en el cuerpo; "descargar" y "mail" exigen motivo e institución receptora.
const TIPO_SOLICITUD_VER = 1;

export type TipoCertificadoAvaluo = 'simple' | 'multipropietario' | 'detallado';

export interface Comuna {
  codigo: number;
  nombre: string;
  regional: number;
}

export interface Copropietario {
  rut: string;
  nombre: string;
  porcentajeDerechos: number;
  fojas: string;
  numero: number;
  anio: number;
  fechaInscripcion: string;
}

export interface SolicitudDocumento {
  id: number;
  fecha: string;
  finVigencia: string;
  estado: string;
  tipo: string;
  folio: string;
  codigoVerificacion: string;
  // Ruta relativa que el portal publica para bajar el PDF. Se conserva tal cual
  // —es un identificador opaco— y `descargarDocumento` sabe resolverla.
  url: string;
}

export interface PropiedadConsultada {
  comuna: string;
  rol: string;
  direccion: string;
  destino: string;
  avaluoFiscal: string;
  contribuciones: string;
}

// Identifica un predio en el catastro: es lo que reciben la consulta por rol,
// los copropietarios y los certificados. El rol "00632-00244" que muestra el
// portal es manzana-predio con ceros a la izquierda; acá van como números, que
// es como los manda la propia SPA.
export interface RolPredio {
  comuna: number;
  manzana: number;
  predio: number;
}

// Un bien raíz tal como lo devuelve la API, con los códigos que hacen falta
// para las demás consultas. Extiende el contrato del scraper de navegador en
// vez de reemplazarlo: quien ya consumía `comuna`, `rol`, `avaluoFiscal`...
// sigue recibiendo lo mismo, más los códigos del catastro.
export interface BienRaizHttp extends BienRaiz {
  comunaCodigo: number;
  manzana: number;
  predio: number;
  ultimoEacAplicado: number;
}

export interface BienesRaicesHttpResult extends BienesRaicesResult {
  propiedades: BienRaizHttp[];
}

export class BienesRaicesHttpScraper {
  private handshakeHecho = false;

  constructor(
    private http: SiiHttpClient,
    private session: SessionManager
  ) {}

  private base(): string {
    const { rut, dv } = this.session.identidad();
    return `${HOST}/app/vica/${rut}-${dv}/v1`;
  }

  // La API responde 0 bytes —no un error, cero bytes— si la sesión no pasó
  // antes por la SPA: el index y `/app/session/status` dejan una cookie del
  // contexto `/app` sin la cual el backend no contesta. Medido: seis rutas
  // correctas parecieron no existir hasta reproducir este orden. Se hace una vez
  // por instancia y se guardan las cookies que devuelva.
  private async handshake(): Promise<void> {
    if (this.handshakeHecho) return;
    this.session.assertPuedeEntregarCookieJar();
    await this.http.get(ENTRADA, undefined, { guardarCookies: true });
    await this.http.get(`${HOST}/app/session/status`, { originalUrl: ENTRADA },
      { guardarCookies: true, accept: 'application/json' });
    this.handshakeHecho = true;
  }

  private async getJson<T>(ruta: string, params?: Record<string, string>): Promise<T> {
    await this.handshake();
    const crudo = await this.http.get(`${this.base()}${ruta}`, params,
      { guardarCookies: true, accept: 'application/json' });
    return this.parsear<T>(crudo, ruta);
  }

  private async postJson<T>(ruta: string, body: unknown): Promise<T> {
    await this.handshake();
    const crudo = await this.http.postJson(`${this.base()}${ruta}`, body,
      { guardarCookies: true, accept: 'application/json' });
    return this.parsear<T>(crudo, ruta);
  }

  private parsear<T>(crudo: string, ruta: string): T {
    // Cuerpo vacío es el modo de falla característico de esta API cuando le
    // falta contexto de sesión. Se nombra, porque "Unexpected end of JSON" manda
    // a buscar un bug de parseo cuando el problema es la sesión.
    if (crudo.trim() === '') {
      throw new Error(
        `La API de bienes raíces respondió vacío en ${ruta}. Suele ser la sesión del `
        + 'portal caída: reintentá.');
    }
    try {
      return JSON.parse(crudo) as T;
    } catch {
      throw new Error(
        `La API de bienes raíces no devolvió JSON en ${ruta}. La sesión pudo expirar. `
        + `Respuesta: ${crudo.slice(0, 200)}`);
    }
  }

  // Algunas rutas envuelven la respuesta al estilo Spring (`{statusCodeValue,
  // body}`) y otras devuelven el dato pelado: conviven dos backends detrás del
  // mismo gateway. Se acepta cualquiera de las dos formas.
  private desenvolver<T>(resp: unknown): T {
    const r = resp as { body?: T; statusCodeValue?: number } | T;
    if (r && typeof r === 'object' && 'body' in (r as object) && 'statusCodeValue' in (r as object)) {
      return (r as { body: T }).body;
    }
    return r as T;
  }

  /**
   * Resumen y listado de los bienes raíces del contribuyente autenticado.
   *
   * El total se cuenta de la LISTA y no de la cabecera: medido en vivo, la
   * cabecera informó `totalBienesRaices: 0` para un contribuyente con veinte
   * propiedades. La SPA muestra la lista igual, así que la lista es la verdad y
   * la cabecera aporta lo demás (solicitudes, notificaciones, flags).
   */
  async listBienesRaices(): Promise<BienesRaicesHttpResult> {
    const cabecera = this.desenvolver<CabeceraApi>(await this.getJson('/mis-bbrr/obtener/cabecera'));
    const lista = this.desenvolver<PropiedadApi[]>(await this.getJson('/mis-bbrr/get/by-rut'));

    if (!Array.isArray(lista)) {
      throw new Error('La API de bienes raíces no devolvió una lista de propiedades.');
    }

    const propiedades = lista.map(p => this.aBienRaiz(p));
    const resumen: ResumenBienesRaices = {
      totalBienesRaices: propiedades.length,
      solicitudesEnCurso: cabecera.solicitudesEnCurso ?? 0,
      solicitudesResueltas: cabecera.solicitudesCerradas ?? 0,
      notificaciones: cabecera.notificacionesDeBBRR ?? 0,
      afectoSobretasa: cabecera.sobretasaModernizacion === true,
      beneficioAdultoMayor: cabecera.beneficiosAdultoMayor === true,
    };
    return { resumen, propiedades };
  }

  private aBienRaiz(p: PropiedadApi): BienRaizHttp {
    return {
      comuna: p.comuna ?? '',
      rol: p.rol ?? '',
      direccion: p.direccion ?? '',
      destino: p.destino ?? '',
      // `fojas` ya venía como string en el contrato del navegador; se respeta.
      fojas: p.fojas === null || p.fojas === undefined ? '' : String(p.fojas),
      numero: p.numero === null || p.numero === undefined ? '' : String(p.numero),
      anio: p.anno === null || p.anno === undefined ? '' : String(p.anno),
      // El porcentaje viene como string con punto decimal ("100.00").
      porcentajeDerechos: Number(p.porcentajeDerecho ?? 0) || 0,
      avaluoFiscal: Number(p.avaluoFiscal ?? 0) || 0,
      comunaCodigo: Number(p.comunaCnp),
      manzana: Number(p.manzanaCnp),
      predio: Number(p.predioCnp),
      ultimoEacAplicado: Number(p.ultimoEacAplicado ?? 0),
    };
  }

  async comunas(): Promise<Comuna[]> {
    const lista = this.desenvolver<ComunaApi[]>(await this.getJson('/comuna/obtener/comunas'));
    if (!Array.isArray(lista)) {
      throw new Error('La API de bienes raíces no devolvió la lista de comunas.');
    }
    // El código útil es `codigoConaraSii`: es el que las demás rutas esperan en
    // `comuna`/`comunaCnp`. El campo `codigo` viene en 0 en toda la lista.
    return lista.map(c => ({ codigo: c.codigoConaraSii, nombre: c.nombre, regional: c.regional }));
  }

  async multipropietarios(rol: RolPredio): Promise<Copropietario[]> {
    const lista = this.desenvolver<CopropietarioApi[]>(await this.getJson(
      '/multipropietarios/get/by-rol',
      { comuna: String(rol.comuna), manzana: String(rol.manzana), predio: String(rol.predio) }));
    if (!Array.isArray(lista)) {
      throw new Error('La API de bienes raíces no devolvió la lista de copropietarios.');
    }
    return lista.map(c => ({
      // Viene con espacios y puntos ("  17.270.613-4"); se normaliza al formato
      // del resto del servicio.
      rut: String(c.rutPropietario ?? '').replace(/[\s.]/g, ''),
      nombre: c.nombrePropietario ?? '',
      porcentajeDerechos: Number(c.porcentajeDerecho ?? 0) || 0,
      fojas: c.fojas === null || c.fojas === undefined ? '' : String(c.fojas),
      numero: Number(c.numero ?? 0) || 0,
      anio: Number(c.anno ?? 0) || 0,
      fechaInscripcion: c.fechaInscripcionString ?? '',
    }));
  }

  async solicitudes(): Promise<SolicitudDocumento[]> {
    const lista = this.desenvolver<SolicitudApi[]>(await this.getJson('/obtener/solicitudes'));
    if (!Array.isArray(lista)) {
      throw new Error('La API de bienes raíces no devolvió la lista de solicitudes.');
    }
    return lista.map(s => ({
      id: s.id,
      fecha: s.fechaString ?? '',
      finVigencia: s.finVigenciaString ?? '',
      estado: s.estadoGlosa ?? '',
      tipo: (s.tipoSolicitud ?? '').trim(),
      folio: s.folio ?? '',
      codigoVerificacion: s.codigoVerificacion ?? '',
      url: s.url ?? '',
    }));
  }

  /**
   * Consulta "sin clave" de un predio cualquiera, por rol. Es la misma que el
   * portal ofrece a terceros: no exige ser el propietario.
   *
   * La SPA la llama con POST aunque el nombre diga `obtener`, y distingue 200
   * (hay datos) de 204 (no hay): acá un cuerpo vacío se traduce a
   * `RecursoNoEncontrado`, no a lista vacía, porque la API contesta 204 también
   * cuando el rol no existe.
   */
  async consultarPorRol(rol: RolPredio): Promise<PropiedadConsultada[]> {
    await this.handshake();
    const crudo = await this.http.postJson(`${this.base()}/mis-bbrr/obtener/by-rol-sc`,
      { comunaCnp: rol.comuna, manzanaCnp: rol.manzana, predioCnp: rol.predio },
      { guardarCookies: true, accept: 'application/json' });
    if (crudo.trim() === '') {
      throw new RecursoNoEncontrado(
        `El SII no tiene un predio con rol ${rol.manzana}-${rol.predio} en la comuna ${rol.comuna}.`);
    }
    const lista = this.desenvolver<PropiedadSinClaveApi[]>(this.parsear(crudo, '/mis-bbrr/obtener/by-rol-sc'));
    if (!Array.isArray(lista)) {
      throw new Error('La consulta por rol no devolvió una lista.');
    }
    return lista.map(p => ({
      comuna: p.comuna ?? '',
      rol: p.rol ?? '',
      direccion: p.direccion ?? '',
      destino: p.destino ?? '',
      // Vienen con relleno de espacios a la izquierda ("              51.230.998").
      avaluoFiscal: (p.avaluoFiscalS ?? '').trim(),
      contribuciones: (p.totalContribS ?? '').trim(),
    }));
  }

  /**
   * Genera un certificado de avalúo fiscal y devuelve el PDF.
   *
   * Es una SOLICITUD al SII: queda registrada en el historial del contribuyente
   * (`solicitudes`) con folio y código de verificación. No es un acto tributario
   * ni tiene costo, pero tampoco es una lectura pura, y por eso no se cachea ni
   * se reintenta solo.
   *
   * El body es el `parametroscertificados` que arma la SPA, con los valores que
   * manda su flujo "Ver certificado": `motivo` e `institucionReceptor` son la
   * cadena "0" —el centinela de "no aplica"— y `otraInstitucion` se OMITE.
   * Mandarlos como "" devuelve "Error en los parametros enviados", y mandar un
   * array de predios (la forma de otro flujo del bundle) devuelve 400. Los dos
   * medidos contra el backend real.
   */
  async certificadoAvaluo(
    bienes: (RolPredio & { ultimoEacAplicado: number })[],
    tipo: TipoCertificadoAvaluo = 'simple'
  ): Promise<Buffer> {
    if (bienes.length === 0) {
      throw new Error('Hace falta al menos un bien raíz para pedir el certificado.');
    }
    const tipoDocumento = tipo === 'simple' ? TIPO_DOCUMENTO.avaluoSimple
      : tipo === 'multipropietario' ? TIPO_DOCUMENTO.avaluoPropietario
        : TIPO_DOCUMENTO.avaluoDetallado;

    const body = {
      // Strings, porque así son las constantes del bundle; `tipoSolicitud` va
      // como número porque la SPA lo pasa por `Number()`.
      tipoDocumento,
      tipoSolicitante: TIPO_SOLICITANTE_CONTRIBUYENTE_AUTENTICADO,
      motivo: '0',
      institucionReceptor: '0',
      tipoSolicitud: TIPO_SOLICITUD_VER,
      // La SPA lo manda como "" en este flujo, no como boolean.
      incluirMultiProp: '',
      bienesRaices: bienes.map(b => ({
        comunaCnp: b.comuna, manzanaCnp: b.manzana, predioCnp: b.predio,
        ultimoEacAplicado: b.ultimoEacAplicado,
      })),
    };

    await this.handshake();
    const crudo = await this.http.postJson(`${this.base()}/cert-avaluo-fiscal/post/${tipo}`, body,
      { guardarCookies: true, accept: 'application/json, text/plain' });
    return this.pdfDesdeBase64(crudo, 'certificado de avalúo');
  }

  /** Baja el PDF de una solicitud ya generada, por la `url` que publica `solicitudes`. */
  async descargarDocumento(url: string): Promise<Buffer> {
    if (!/^\/descarga\/documento\/[A-Za-z0-9-]+\/[A-Za-z0-9]+$/.test(url)) {
      throw new Error(
        'La url del documento tiene que ser la que devuelve la lista de solicitudes '
        + `(/descarga/documento/{codigo}/{folio}); se recibió "${url.slice(0, 60)}".`);
    }
    await this.handshake();
    const { contenido, contentType } = await this.http.getBinario(`${this.base()}${url}`);
    if (/pdf|octet-stream/i.test(contentType)) return contenido;
    // Si no vino binario, puede venir el base64 como texto, igual que el
    // certificado.
    return this.pdfDesdeBase64(contenido.toString('latin1'), 'documento de la solicitud');
  }

  // La SPA hace `window.atob(respuesta)`: el cuerpo es el base64 del PDF, a
  // secas. Se valida la firma `%PDF-` porque un error del backend también llega
  // como texto, y base64-decodificar un mensaje de error da bytes que ningún
  // lector abre — y nadie se entera hasta abrirlo.
  private pdfDesdeBase64(crudo: string, que: string): Buffer {
    const texto = crudo.trim().replace(/^"|"$/g, '');
    if (texto === '') throw new Error(`El SII respondió vacío al pedir el ${que}.`);
    const pdf = Buffer.from(texto, 'base64');
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error(
        `El SII no devolvió un PDF al pedir el ${que}. Respuesta: ${texto.slice(0, 160)}`);
    }
    return pdf;
  }
}

// Formas crudas de la API, con los nombres del SII. No se exportan: el contrato
// hacia afuera es el de las interfaces de arriba.
interface CabeceraApi {
  totalBienesRaices?: number;
  solicitudesEnCurso?: number;
  solicitudesCerradas?: number;
  notificacionesDeBBRR?: number;
  sobretasaModernizacion?: boolean;
  beneficiosAdultoMayor?: boolean;
}

interface PropiedadApi {
  comunaCnp: number;
  manzanaCnp: number;
  predioCnp: number;
  ultimoEacAplicado?: number;
  comuna?: string;
  rol?: string;
  direccion?: string;
  destino?: string;
  fojas?: string | number | null;
  numero?: number | null;
  anno?: number | null;
  porcentajeDerecho?: string | number | null;
  avaluoFiscal?: number | null;
}

interface ComunaApi { codigoConaraSii: number; nombre: string; regional: number; }

interface CopropietarioApi {
  rutPropietario?: string;
  nombrePropietario?: string;
  porcentajeDerecho?: number | string;
  fojas?: string | number | null;
  numero?: number | null;
  anno?: number | null;
  fechaInscripcionString?: string;
}

interface SolicitudApi {
  id: number;
  fechaString?: string;
  finVigenciaString?: string;
  estadoGlosa?: string;
  tipoSolicitud?: string;
  folio?: string;
  codigoVerificacion?: string;
  url?: string;
}

interface PropiedadSinClaveApi {
  comuna?: string;
  rol?: string;
  direccion?: string;
  destino?: string;
  avaluoFiscalS?: string;
  totalContribS?: string;
}
