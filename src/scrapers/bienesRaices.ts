import { Browser } from '../browser';
import { SessionManager } from '../session';

export interface BienRaiz {
  comuna: string;
  rol: string;
  direccion: string;
  destino: string;
  fojas: string;
  numero: string;
  anio: string;
  porcentajeDerechos: number;
  avaluoFiscal: number;
}

export interface ResumenBienesRaices {
  totalBienesRaices: number;
  solicitudesEnCurso: number;
  solicitudesResueltas: number;
  notificaciones: number;
  afectoSobretasa: boolean;
  beneficioAdultoMayor: boolean;
}

export interface BienesRaicesResult {
  resumen: ResumenBienesRaices;
  propiedades: BienRaiz[];
}

// El portal de bienes raíces cuelga del RUT persona autenticado: a diferencia
// del portal mipyme, no pasa por selección de empresa.
const BIENES_RAICES_URL = 'https://www2.sii.cl/vica/Menu/BienesRaices';

// La SPA rinde en ~3s; el primer snapshot vuelve prácticamente vacío.
const READY_MARKERS = ['LISTADO DE BIENES RAÍCES', 'CONSULTAR MIS BIENES RAÍCES'];

export class BienesRaicesScraper {
  constructor(
    private browser: Browser,
    private session: SessionManager
  ) {}

  async listBienesRaices(): Promise<BienesRaicesResult> {
    await this.session.authenticateOnly();
    this.browser.open(BIENES_RAICES_URL);
    this.browser.waitForAny(READY_MARKERS, 30_000);
    const snapshot = this.browser.snapshot();

    return {
      resumen: this.parseResumen(snapshot),
      propiedades: this.parsePropiedades(snapshot),
    };
  }

  // Los tiles del encabezado son bloques de StaticText consecutivos: el título,
  // un subtítulo y el valor. Se ancla en el título y se lee el último texto.
  private parseResumen(snapshot: string): ResumenBienesRaices {
    const solicitudes = this.tileValue(snapshot, 'Solicitudes') ?? '';
    const [enCurso, resueltas] = solicitudes.split('/').map(p => this.toInt(p));

    return {
      totalBienesRaices: this.toInt(this.tileValue(snapshot, 'Total bienes')),
      solicitudesEnCurso: enCurso ?? 0,
      solicitudesResueltas: resueltas ?? 0,
      notificaciones: this.toInt(this.tileValue(snapshot, 'Notificaciones')),
      afectoSobretasa: this.tileValue(snapshot, 'Sobretasa') === 'SI',
      beneficioAdultoMayor: this.tileValue(snapshot, 'Beneficio') === 'SI',
    };
  }

  private tileValue(snapshot: string, titulo: string): string | undefined {
    const lines = snapshot.split('\n');
    const start = lines.findIndex(l => new RegExp(`- StaticText "${titulo}`).test(l));
    if (start === -1) return undefined;

    // Recorrer los StaticText del tile y quedarse con el último con contenido
    // real: varios tiles cierran con un "ℹ" decorativo que no es el valor.
    let value: string | undefined;
    for (let i = start + 1; i < lines.length && i <= start + 6; i++) {
      const m = lines[i].trim().match(/^- StaticText "([^"]*)"$/);
      if (m) {
        const text = m[1].trim();
        if (text && !this.esDecorativo(text)) value = text;
        continue;
      }
      if (/^- (LineBreak|generic)/.test(lines[i].trim())) continue;
      break;
    }
    return value;
  }

  // Iconos informativos que el portal intercala entre los textos del tile.
  private esDecorativo(text: string): boolean {
    return !/[0-9A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(text);
  }

  private parsePropiedades(snapshot: string): BienRaiz[] {
    const propiedades: BienRaiz[] = [];
    const lines = snapshot.split('\n');

    let i = 0;
    while (i < lines.length) {
      const rowMatch = lines[i].match(/^(\s+)- row$/);
      if (!rowMatch) { i++; continue; }

      const rowIndent = rowMatch[1].length;
      const cellIndent = rowIndent + 2;

      const cells: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const cl = lines[j];
        if (cl.length > 0 && !cl.startsWith(' '.repeat(rowIndent + 1))) break;
        if (cl.startsWith(' '.repeat(cellIndent) + '- ')) {
          const t = cl.trim();
          const m = t.match(/^- cell "([^"]*)"/);
          if (m) cells.push(m[1]);
          else if (/^- cell\s*$/.test(t)) cells.push('');
        }
        j++;
      }
      i = j;

      const propiedad = this.rowToBienRaiz(cells);
      if (propiedad) propiedades.push(propiedad);
    }

    return propiedades;
  }

  // Celdas: [checkbox, Comuna, ROL, Dirección, Destino, F2890, Número, Año,
  // % derechos, Avalúo, Estado cuotas, Otras opciones].
  private rowToBienRaiz(cells: string[]): BienRaiz | null {
    if (cells.length < 10) return null;

    const rol = cells[2];
    // El ROL tiene formato NNNNN-NNNNN; descarta filas de encabezado o vacías.
    if (!/^\d+-\d+$/.test(rol)) return null;

    return {
      comuna: cells[1],
      rol,
      direccion: cells[3],
      destino: cells[4],
      fojas: this.soloDigitos(cells[5]),
      numero: cells[6],
      anio: cells[7],
      porcentajeDerechos: this.toFloat(cells[8]),
      avaluoFiscal: this.toInt(cells[9]),
    };
  }

  // La celda de inscripción viene como "Descargar formulario de F2890 6603":
  // el número de fojas es lo último.
  private soloDigitos(text: string): string {
    const m = text.match(/(\d+)\s*$/);
    return m ? m[1] : '';
  }

  private toInt(text: string | undefined): number {
    if (!text) return 0;
    const digits = text.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
  }

  // El porcentaje usa punto decimal ("100.00 %"), a diferencia de los montos
  // que usan el punto como separador de miles.
  private toFloat(text: string | undefined): number {
    if (!text) return 0;
    const m = text.match(/(\d+(?:[.,]\d+)?)/);
    return m ? parseFloat(m[1].replace(',', '.')) : 0;
  }
}
