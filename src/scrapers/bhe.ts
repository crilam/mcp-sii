import { SiiHttpClient } from '../http';
import { SessionManager } from '../session';

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

export interface BoletaBhe {
  folio: number;
  fecha: string;
  receptorRut: string;
  receptorNombre: string;
  honorarioBruto: number;
  retencionEmisor: number;
  retencionReceptor: number;
  totalLiquido: number;
  anulada: boolean;
}

const BASE = 'https://loa.sii.cl/cgi_IMT';
const CGI_ANUAL = `${BASE}/TMBCOC_InformeAnualBhe.cgi`;
const CGI_MENSUAL = `${BASE}/TMBCOC_InformeMensualBhe.cgi`;
const CGI_MENSUAL_REC = `${BASE}/TMBCOC_InformeMensualBheRec.cgi`;

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
               'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// El CGI devuelve la tabla vacía y escribe los datos en variables JavaScript
// que el navegador renderiza con document.write. El parser va sobre el fuente.
const XML_VALUE = /xml_values\['(\w+)'\]\s*=\s*"([^"]*)"/g;

export class BheScraper {
  constructor(
    private http: SiiHttpClient,
    private session: SessionManager
  ) {}

  async informeAnual(anio: number): Promise<InformeAnualBhe> {
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
    // No requiere seleccionar empresa: la BHE es de la persona natural.
    await this.session.authenticateOnly();
    const { rut, dv } = this.session.identidad();
    const html = await this.http.postForm(
      recibidas ? CGI_MENSUAL_REC : CGI_MENSUAL,
      {
        rut_arrastre: rut,
        dv_arrastre: dv,
        // Sin este campo el CGI responde el error TMB020a en vez del informe.
        pagina_solicitada: '0',
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

    return this.parseBoletas(html, this.toInt(values['total_boletas']) ?? 0);
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
    const re = /arr_informe_mensual\['([^']+)'\]\s*=\s*([^;]+);/g;
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
    return literal ? literal[1] : '';
  }

  private parseBoletas(html: string, total: number): BoletaBhe[] {
    const arr = this.parseArrInforme(html);
    const boletas: BoletaBhe[] = [];

    for (let i = 1; i <= total; i++) {
      const folio = this.toInt(arr[`nroboleta_${i}`]);
      // Un indice sin folio significa que el SII devolvio menos filas de las
      // que anuncio: se omite en vez de inventar una boleta vacia.
      if (folio === null) continue;

      const estado = (arr[`estado_${i}`] ?? '').trim();
      const fechaAnulacion = (arr[`fechaanulacion_${i}`] ?? '').trim();

      boletas.push({
        folio,
        fecha: (arr[`fechaemision_${i}`] ?? '').trim(),
        receptorRut: `${arr[`rutreceptor_${i}`] ?? ''}-${arr[`dvreceptor_${i}`] ?? ''}`,
        receptorNombre: (arr[`nombrereceptor_${i}`] ?? '').trim(),
        honorarioBruto: this.toInt(arr[`totalhonorarios_${i}`]) ?? 0,
        retencionEmisor: this.toInt(arr[`retencion_emisor_${i}`]) ?? 0,
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
}
