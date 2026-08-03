import { SiiHttpClient } from '../http';
import { Empresa, SessionManager } from '../session';

// Portal mipyme (Sistema de Facturación Gratuito) por HTTP directo, sin
// navegador. Contratos relevados en vivo el 2026-08-03:
// docs/superpowers/specs/2026-08-03-mipyme-http-contratos.md
//
// Son CGI legacy, no aplicaciones SDI: responden HTML en ISO-8859-1 y hay que
// parsearlo. El mismo terreno que las boletas de honorarios.
const CGI_BASE = 'https://www1.sii.cl/cgi-bin/Portal001';
const SEL_EMPRESA_URL = `${CGI_BASE}/mipeSelEmpresa.cgi`;
const HISTORIAL_URL = `${CGI_BASE}/mipeAdminDocsEmi.cgi`;

const TIPO_DTE_NOMBRES: Record<string, number> = {
  'Factura Electronica': 33,
  'Factura No afecta o exenta': 34,
  'Factura Exenta Electronica': 34,
  'Nota de Credito': 61,
  'Nota de Credito Electronica': 61,
  'Nota de Debito': 56,
  'Nota de Debito Electronica': 56,
  'Guia de Despacho': 52,
  'Factura de Compra': 46,
};

export interface DteEmitidoMipyme {
  tipoDte: number;
  tipoDteNombre: string;
  folio: number;
  fecha: string;
  receptorRut: string;
  receptorNombre: string;
  monto: number;
  estado: string;
  // Identificador interno del documento que trae el link de cada fila. NO es el
  // folio y no se puede derivar de los datos de la fila: es el único parámetro
  // con el que el CGI de detalle (mipeGesDocEmi.cgi) acepta ser consultado, así
  // que se propaga en vez de descartarse.
  codigo: string;
}

export interface FiltrosDteEmitidos {
  empresaRut: string;
  tipoDte?: number;
  fechaDesde?: string;
  fechaHasta?: string;
  receptorRut?: string;
  folio?: number;
  pagina?: number;
}

export interface DteEmitidosResult {
  documentos: DteEmitidoMipyme[];
  // El CGI pagina de a 100 filas y no informa cuántas páginas hay en un campo
  // legible. Sin decir qué página se pidió, una página inexistente devuelve una
  // lista vacía indistinguible de "esta empresa no emitió nada".
  pagina: number;
  empresaRut: string;
}

export class MipymeHttpScraper {
  constructor(
    private http: SiiHttpClient,
    private session: SessionManager
  ) {}

  // Las consultas por HTTP necesitan el cookie jar, que sólo produce la
  // autenticación con certificado. Se verifica ANTES de tocar la red para no
  // abrir una sesión en el SII que no se va a poder usar (ver
  // SessionManager.assertPuedeEntregarCookieJar).
  async listEmpresas(): Promise<Empresa[]> {
    this.session.assertPuedeEntregarCookieJar();
    return this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
  }

  // La empresa activa del portal mipyme es estado del lado del SERVIDOR: el POST
  // de selección no escribe ninguna cookie que podamos inspeccionar (medido
  // comparando el cookie jar antes y después). O sea que dos consultas con
  // empresas distintas se pisan igual que con el navegador —A selecciona, B
  // selecciona, A lee, y A devuelve datos de B como si fueran propios—, así que
  // el ciclo completo va serializado. El candado no es herencia del navegador.
  async listDteEmitidos(filtros: FiltrosDteEmitidos): Promise<DteEmitidosResult> {
    const pagina = filtros.pagina ?? 1;
    if (!Number.isInteger(pagina) || pagina < 1) {
      throw new Error(`pagina debe ser un entero mayor o igual a 1; se recibió ${filtros.pagina}`);
    }
    this.session.assertPuedeEntregarCookieJar();

    return this.session.conEmpresaExclusiva(async () => {
      const empresas = this.parseEmpresas(await this.http.get(SEL_EMPRESA_URL));
      if (!empresas.some(e => e.rut === filtros.empresaRut)) {
        throw new Error(
          `La empresa ${filtros.empresaRut} no está entre las que este RUT puede operar en el ` +
          `portal mipyme. Disponibles: ${empresas.map(e => e.rut).join(', ')}`
        );
      }

      await this.http.postForm(SEL_EMPRESA_URL, { RUT_EMP: filtros.empresaRut });

      const html = await this.http.get(HISTORIAL_URL, this.params(filtros, pagina));
      this.assertEmpresaSeleccionada(html);

      return {
        documentos: this.parseHistorial(html),
        pagina,
        empresaRut: filtros.empresaRut,
      };
    });
  }

  private params(filtros: FiltrosDteEmitidos, pagina: number): Record<string, string> {
    return {
      RUT_RECP: filtros.receptorRut ?? '',
      FOLIO: filtros.folio ? String(filtros.folio) : '',
      RZN_SOC: '',
      FEC_DESDE: filtros.fechaDesde ? this.aFechaSii(filtros.fechaDesde) : '',
      FEC_HASTA: filtros.fechaHasta ? this.aFechaSii(filtros.fechaHasta) : '',
      TPO_DOC: filtros.tipoDte ? String(filtros.tipoDte) : '',
      ESTADO: '',
      ORDEN: '',
      NUM_PAG: String(pagina),
    };
  }

  private aFechaSii(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  // El CGI responde 200 con un alert() de JavaScript cuando falta el paso de
  // selección de empresa. Es un fallo reconocible y hay que reportarlo como tal:
  // dejarlo pasar devolvería cero documentos, que se lee como "esta empresa no
  // emitió nada" en un período que puede tener cientos.
  private assertEmpresaSeleccionada(html: string): void {
    if (/no ha seleccionado una Empresa/i.test(html)) {
      const codigo = html.match(/CODIGO:\s*([\d.\-]+)/)?.[1] ?? 'sin código';
      throw new Error(
        `El portal mipyme respondió que no ha seleccionado una Empresa (código ${codigo}). ` +
        `La selección se perdió entre el POST y la consulta: reintentá la operación.`
      );
    }
  }

  private parseEmpresas(html: string): Empresa[] {
    const empresas: Empresa[] = [];
    // El texto se corta con un LOOKAHEAD, no consumiendo el `<`. Los `<option>`
    // del SII no cierran, así que un patrón que se coma el `<` del siguiente
    // avanza el lastIndex más allá de su apertura y se saltea una empresa de
    // cada dos: cinco en el combo, tres devueltas, sin ningún error. Medido
    // contra el portal real. La fixture conserva los `<option>` sin cerrar.
    for (const m of html.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)(?=<)/g)) {
      const rut = m[1].trim();
      if (!/^\d{5,}-[\dkK]$/.test(rut)) continue;
      // El texto de la opción repite el RUT al final ("EMPRESA SPA 22222222-2"):
      // se quita para que el nombre sea sólo el nombre.
      const nombre = this.decodificar(m[2]).replace(/\s*\d{5,}-[\dkK]\s*$/, '').trim();
      empresas.push({ rut, nombre: nombre || rut });
    }

    // Un combo sin opciones no es "esta persona no opera ninguna empresa": es el
    // CGI devolviendo otra página (sesión caída, WAF, rediseño). Devolver [] haría
    // los dos casos indistinguibles.
    if (empresas.length === 0) {
      throw new Error(
        'El portal mipyme no devolvió ninguna empresa en la página de selección. ' +
        'Puede ser la sesión caída o un cambio del portal; no significa que este RUT no opere empresas.'
      );
    }
    return empresas;
  }

  // ATENCIÓN al `<td>` sin cerrar: la celda del RUT del receptor viene como
  // `<td>77777777-7<td>RAZON SOCIAL</td>`, o sea HTML malformado que manda el
  // propio SII. Cortar cada celda en `</td>` **o** en el `<td` siguiente es lo
  // que hace que salgan las 8 columnas del header; exigir el cierre devuelve 7,
  // pierde el RUT y corre todo un lugar, dejando `receptorRut` poblado con la
  // razón social y sin ningún error visible. Hay una fixture que conserva la
  // malformación y un test que fija las 8 columnas.
  private parseHistorial(html: string): DteEmitidoMipyme[] {
    const docs: DteEmitidoMipyme[] = [];

    for (const fila of html.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const bruto = fila[0];
      const celdas = [...bruto.matchAll(/<td[^>]*>([\s\S]*?)(?=<\/td>|<td)/gi)]
        .map(c => this.decodificar(c[1].replace(/<[^>]*>/g, ' ')).trim());

      // [0]=Ver (link, sin texto) [1]=RUT receptor [2]=razón social
      // [3]=tipo de documento [4]=folio [5]=fecha [6]=monto [7]=estado
      if (celdas.length < 8 || !/^\d+$/.test(celdas[4])) continue;

      const codigo = bruto.match(/CODIGO=(\d+)/)?.[1];
      if (!codigo) continue;

      docs.push({
        receptorRut: celdas[1],
        receptorNombre: celdas[2],
        tipoDteNombre: celdas[3],
        tipoDte: TIPO_DTE_NOMBRES[celdas[3]] ?? 0,
        folio: parseInt(celdas[4], 10),
        // El HTML trae AAAA-MM-DD y montos sin separador de miles, a diferencia
        // de la tabla renderizada (dd/mm/aaaa con puntos). Se preserva el
        // formato del origen en vez de reformatear.
        fecha: celdas[5],
        monto: parseInt(celdas[6].replace(/\./g, ''), 10) || 0,
        estado: celdas[7],
        codigo,
      });
    }
    return docs;
  }

  // Las entidades HTML de los CGI legacy vienen sin decodificar. Sólo se
  // traducen las que aparecen en estos campos (nombres de empresa y de tipos de
  // documento); no hace falta un decodificador general.
  private decodificar(texto: string): string {
    return texto
      .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
      .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
      .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
      .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
  }
}
