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

const BASE = 'https://loa.sii.cl/cgi_IMT';
const CGI_ANUAL = `${BASE}/TMBCOC_InformeAnualBhe.cgi`;

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
    const digits = text.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : null;
  }
}
