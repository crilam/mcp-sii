import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';

// Estado de una declaración de renta (F22) de un año tributario.
export interface DeclaracionRenta {
  folio: number;
  periodo: string;
  // `vgte === '1'` marca la declaración vigente del año: un mismo período
  // puede tener varias (borradores, rectificatorias) y sólo una está vigente.
  vigente: boolean;
  // Código de estado del SII (evigCodigo). Es una sigla — "IPG", "ODT", "NST" —
  // que no se traduce acá a propósito: el texto que explica el estado son las
  // glosas, y adivinar una traducción propia inventaría significado.
  estadoCodigo: string;
  // Enlaza esta declaración con su glosa (glosa.codConclusion).
  codigoConclusion: string;
  contribuyente: string;
  comuna: string;
  direccion: string;
  fechaVencimiento: string;
  remanenteSolicitado: number;
  remanenteDevuelto: number;
}

// Explicación en texto del estado de la declaración. Es lo más útil que
// devuelve este servicio para una persona: dice si hubo devolución, por cuánto,
// o qué inconsistencia se detectó. Nunca se omite del resultado.
export interface GlosaRenta {
  codigoConclusion: string;
  descripcion: string;
}

export interface EstadoDeclaracionRenta {
  anio: string;
  // `true` cuando el SII respondió que no hay datos para ese año tributario:
  // un vacío legítimo, no un fallo (ver interpretarRespuesta).
  sinDatos: boolean;
  declaraciones: DeclaracionRenta[];
  glosas: GlosaRenta[];
}

// Una línea del formulario 22 completo.
export interface LineaF22 {
  codigo: number;
  valor: string;
  glosa: string;
}

export interface F22Completo {
  anio: string;
  folio: number;
  sinDatos: boolean;
  lineas: LineaF22[];
}

const BASE = 'https://www4.sii.cl/consultaestadof22ui/services/data/facadeService';
const NAMESPACE = 'cl.sii.sdi.lob.renta.consultaestadof22.data.api.interfaces.FacadeService';

// Código con que esta aplicación informa "no hay datos para esos parámetros".
// Ojo: es el código de renta. Otras aplicaciones del portal (por ejemplo el
// Registro de Compras y Ventas) traen su propio esquema de códigos, con otros
// valores y otro nombre de campo. No se comparten.
const RESP_SIN_DATOS = 2;

export class RentaScraper {
  constructor(
    private http: SiiHttpClient,
    private session: SessionManager
  ) {}

  async estadoDeclaracion(anio: number): Promise<EstadoDeclaracionRenta> {
    const periodo = String(anio);
    const data = await this.consultar('buscaDeclVgte', { periodo });

    if (data === null) {
      return { anio: periodo, sinDatos: true, declaraciones: [], glosas: [] };
    }

    return {
      anio: periodo,
      sinDatos: false,
      declaraciones: (data.decls ?? []).map((d: any) => this.aDeclaracion(d, periodo)),
      glosas: (data.glosas ?? []).map((g: any) => ({
        codigoConclusion: String(g.codConclusion ?? ''),
        descripcion: (g.descripcion ?? '').trim(),
      })),
    };
  }

  // `folio` es opcional: cuando no viene se resuelve desde la declaración
  // vigente del año. Es una consulta extra al SII, y sólo funciona si el año
  // tiene una declaración vigente; si no la tiene, se falla con un mensaje que
  // lo dice, en vez de devolver un formulario vacío que parecería un año sin
  // movimientos.
  async f22Completo(anio: number, folio?: number): Promise<F22Completo> {
    const periodo = String(anio);
    const folioResuelto = folio ?? await this.folioVigente(anio);

    // OJO: el método es `f22Completo` y está verificado en vivo — devuelve los
    // 76 códigos del formulario. Lo que confunde es que la respuesta ecoa en su
    // metaData un namespace terminado en `f22Compacto`: ese es el nombre interno
    // de la implementación del SII, no el del método que hay que invocar. No lo
    // "corrijas" al ver el eco: invocar `f22Compacto` no es lo que se verificó.
    const data = await this.consultar('f22Completo', {
      folio: String(folioResuelto),
      periodo,
    });

    if (data === null) {
      return { anio: periodo, folio: folioResuelto, sinDatos: true, lineas: [] };
    }

    return {
      anio: periodo,
      folio: folioResuelto,
      sinDatos: false,
      lineas: (data as any[]).map(l => ({
        codigo: Number(l.codigo),
        valor: String(l.valor ?? ''),
        glosa: (l.glosa ?? '').trim(),
      })),
    };
  }

  private async folioVigente(anio: number): Promise<number> {
    const estado = await this.estadoDeclaracion(anio);
    const vigente = estado.declaraciones.find(d => d.vigente);
    if (!vigente) {
      throw new Error(
        `No hay una declaración de renta vigente para el año tributario ${anio}, ` +
        'así que no se puede resolver el folio automáticamente. ' +
        'Consultá primero sii_renta_estado_declaracion y pasá el folio explícito.'
      );
    }
    return vigente.folio;
  }

  private aDeclaracion(d: any, periodoConsultado: string): DeclaracionRenta {
    const nombre = [d.nombres, d.apellidos]
      .filter((p: unknown) => typeof p === 'string' && p.trim())
      .join(' ')
      .trim();

    return {
      folio: Number(d.folio),
      periodo: String(d.periodo ?? periodoConsultado),
      vigente: d.vgte === '1',
      estadoCodigo: (d.evigCodigo ?? '').trim(),
      codigoConclusion: String(d.codConc ?? ''),
      contribuyente: nombre,
      comuna: (d.comuna ?? '').trim(),
      // El SII concatena la dirección con literales "null" cuando falta un
      // componente ("CALLE EJEMPLO 123 null"). Exponerlo así se ve como un bug
      // del servidor MCP, aunque venga del portal.
      direccion: (d.calle ?? '').replace(/\bnull\b/g, '').replace(/\s+/g, ' ').trim(),
      fechaVencimiento: (d.fechaVencimiento ?? '').trim(),
      remanenteSolicitado: Number(d.remanenteSolicitado ?? 0),
      remanenteDevuelto: Number(d.remanenteDevuelto ?? 0),
    };
  }

  private async consultar(metodo: string, data: Record<string, string>): Promise<any> {
    // Las consultas de renta cuelgan del RUT persona autenticado: no requieren
    // seleccionar empresa. El servicio quiere el RUT sin dígito verificador y
    // el dv aparte.
    this.session.assertPuedeEntregarCookieJar();
    const { rut, dv } = this.session.identidad();

    const resp = await this.http.postSdi(BASE, NAMESPACE, metodo, { rut, dv, ...data });
    return this.interpretarRespuesta(resp, metodo);
  }

  // Devuelve el `data` de la respuesta, o `null` cuando el SII informó que no
  // hay datos. Los dos casos son respuestas correctas; el resto lanza.
  //
  // Un año sin declaración responde igual que una consulta bien formada que no
  // encontró nada: `respCod: 2` con `data: null`. Tratarlo como error haría que
  // "no declaraste ese año" se reporte como falla del servidor.
  private interpretarRespuesta(resp: any, metodo: string): any {
    // El sobre mal armado devuelve "Acceso no autorizado!", que suena a
    // permisos pero es un problema de formato del sobre SDI. Se cita el mensaje
    // del SII tal cual y se agrega el contexto, para que quien lo lea no pierda
    // la tarde revisando el certificado.
    if (resp?.errorMsg) {
      throw new Error(
        `El SII rechazó la consulta de renta (${metodo}): ${resp.errorMsg}. ` +
        'Si dice "Acceso no autorizado!", suele ser el sobre de la petición mal ' +
        'formado, no un problema de permisos.'
      );
    }

    if (resp?.respCod === RESP_SIN_DATOS && resp?.data == null) return null;

    // Éxito: `data` con contenido. `respCod` puede venir en 0 o directamente
    // ausente según el método, así que lo que define el éxito es que haya datos.
    if (resp?.data != null) return resp.data;

    throw new Error(
      `El SII devolvió una respuesta inesperada en ${metodo} ` +
      `(respCod=${resp?.respCod}). No se puede distinguir de un error, así que ` +
      'no se reporta como "sin datos".'
    );
  }
}
