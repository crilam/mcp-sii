import { Browser } from '../browser';
import { Empresa, SessionManager } from '../session';

export interface DocumentoEmitido {
  tipoDte: number;
  folio: number;
  fecha: string;
  receptorRut: string;
  receptorNombre: string;
  montoNeto: number;
  iva: number;
  total: number;
  estadoSii: string;
}

export interface LineaDetalle {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuento: number;
}

export interface DocumentoEmitidoDetalle extends DocumentoEmitido {
  lineas: LineaDetalle[];
}

export interface DocumentoRecibido {
  tipoDte: number;
  folio: number;
  fecha: string;
  emisorRut: string;
  emisorNombre: string;
  montoNeto: number;
  iva: number;
  total: number;
  estadoRecepcion: string;
}

export interface DocumentoRecibidoDetalle extends DocumentoRecibido {
  lineas: LineaDetalle[];
}

export interface FiltrosEmitidos {
  tipoDte?: number;
  fechaDesde?: string;
  fechaHasta?: string;
  receptorRut?: string;
  limit?: number;
  empresaRut?: string;
}

export interface FiltrosRecibidos {
  tipoDte?: number;
  fechaDesde?: string;
  fechaHasta?: string;
  emisorRut?: string;
  limit?: number;
  empresaRut?: string;
}

const MIPYME_EMITIDOS_URL = 'https://www4.sii.cl/mipymesinternetui/pages/emitidos.xhtml';
const MIPYME_RECIBIDOS_URL = 'https://www4.sii.cl/mipymesinternetui/pages/recibidos.xhtml';

export class MipymeScraper {
  constructor(
    private browser: Browser,
    private session: SessionManager
  ) {}

  async listEmpresas(): Promise<Empresa[]> {
    await this.session.getSession();
    const snapshot = this.browser.snapshot();
    return this.parseEmpresas(snapshot);
  }

  async listDocumentosEmitidos(filtros: FiltrosEmitidos): Promise<DocumentoEmitido[]> {
    return this.withReauth(async () => {
      await this.ensureEmpresa(filtros.empresaRut);
      this.browser.open(MIPYME_EMITIDOS_URL);
      await this.applyFiltrosEmitidos(filtros);
      return this.parseDocumentosEmitidos(this.browser.snapshot(), filtros.limit ?? 50);
    });
  }

  async getDocumentoEmitido(tipoDte: number, folio: number, empresaRut?: string): Promise<DocumentoEmitidoDetalle> {
    return this.withReauth(async () => {
      await this.ensureEmpresa(empresaRut);
      const url = `${MIPYME_EMITIDOS_URL}?tipo=${tipoDte}&folio=${folio}`;
      this.browser.open(url);
      const snapshot = this.browser.snapshot();
      const doc = this.parseDocumentosEmitidos(snapshot, 1)[0];
      if (!doc) throw new Error(`No se encontró el documento tipo ${tipoDte} folio ${folio}`);
      return { ...doc, lineas: this.parseLineasDetalle(snapshot) };
    });
  }

  async listDocumentosRecibidos(filtros: FiltrosRecibidos): Promise<DocumentoRecibido[]> {
    return this.withReauth(async () => {
      await this.ensureEmpresa(filtros.empresaRut);
      this.browser.open(MIPYME_RECIBIDOS_URL);
      await this.applyFiltrosRecibidos(filtros);
      return this.parseDocumentosRecibidos(this.browser.snapshot(), filtros.limit ?? 50);
    });
  }

  async getDocumentoRecibido(tipoDte: number, folio: number, emisorRut: string, empresaRut?: string): Promise<DocumentoRecibidoDetalle> {
    return this.withReauth(async () => {
      await this.ensureEmpresa(empresaRut);
      const url = `${MIPYME_RECIBIDOS_URL}?tipo=${tipoDte}&folio=${folio}&emisor=${emisorRut}`;
      this.browser.open(url);
      const snapshot = this.browser.snapshot();
      const doc = this.parseDocumentosRecibidos(snapshot, 1)[0];
      if (!doc) throw new Error(`No se encontró el documento tipo ${tipoDte} folio ${folio} de ${emisorRut}`);
      return { ...doc, lineas: this.parseLineasDetalle(snapshot) };
    });
  }

  private async withReauth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/sesion|session|autenticacion|unauthorized|401/i.test(msg)) {
        this.session.invalidate();
        await this.session.getSession();
        return fn();
      }
      throw err;
    }
  }

  private async ensureEmpresa(empresaRut?: string): Promise<void> {
    const session = await this.session.getSession();
    if (empresaRut && empresaRut !== session.empresaRut) {
      const snapshot = this.browser.snapshot();
      const selectRef = this.findRef(snapshot, /empresa/i) ?? '@e10';
      this.browser.select(selectRef, empresaRut);
    }
  }

  private async applyFiltrosEmitidos(filtros: FiltrosEmitidos): Promise<void> {
    const snapshot = this.browser.snapshot();
    if (filtros.fechaDesde) {
      const ref = this.findRef(snapshot, /desde|inicio/i);
      if (ref) this.browser.fill(ref, filtros.fechaDesde);
    }
    if (filtros.fechaHasta) {
      const ref = this.findRef(snapshot, /hasta|fin/i);
      if (ref) this.browser.fill(ref, filtros.fechaHasta);
    }
    if (filtros.tipoDte) {
      const ref = this.findRef(snapshot, /tipo.*documento|tipo.*dte/i);
      if (ref) this.browser.select(ref, String(filtros.tipoDte));
    }
    if (filtros.receptorRut) {
      const ref = this.findRef(snapshot, /receptor|rut.*receptor/i);
      if (ref) this.browser.fill(ref, filtros.receptorRut);
    }
    const btnRef = this.findRef(snapshot, /buscar|filtrar|consultar/i);
    if (btnRef) this.browser.click(btnRef);
  }

  private async applyFiltrosRecibidos(filtros: FiltrosRecibidos): Promise<void> {
    const snapshot = this.browser.snapshot();
    if (filtros.fechaDesde) {
      const ref = this.findRef(snapshot, /desde|inicio/i);
      if (ref) this.browser.fill(ref, filtros.fechaDesde);
    }
    if (filtros.fechaHasta) {
      const ref = this.findRef(snapshot, /hasta|fin/i);
      if (ref) this.browser.fill(ref, filtros.fechaHasta);
    }
    if (filtros.tipoDte) {
      const ref = this.findRef(snapshot, /tipo.*documento|tipo.*dte/i);
      if (ref) this.browser.select(ref, String(filtros.tipoDte));
    }
    if (filtros.emisorRut) {
      const ref = this.findRef(snapshot, /emisor|rut.*emisor/i);
      if (ref) this.browser.fill(ref, filtros.emisorRut);
    }
    const btnRef = this.findRef(snapshot, /buscar|filtrar|consultar/i);
    if (btnRef) this.browser.click(btnRef);
  }

  private parseEmpresas(snapshot: string): Empresa[] {
    const regex = /\[option "([^"]+)" value="([^"]+)"\]/g;
    const empresas: Empresa[] = [];
    let match;
    while ((match = regex.exec(snapshot)) !== null) {
      empresas.push({ nombre: match[1], rut: match[2] });
    }
    return empresas;
  }

  private parseDocumentosEmitidos(snapshot: string, limit: number): DocumentoEmitido[] {
    const rowRegex = /\[row\](.*?)\[\/row\]/gs;
    const docs: DocumentoEmitido[] = [];
    let rowMatch;
    while ((rowMatch = rowRegex.exec(snapshot)) !== null && docs.length < limit) {
      const cells: string[] = [];
      let cellMatch;
      const cellRe = new RegExp(/\[cell "([^"]*)"\]/.source, 'g');
      while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) cells.push(cellMatch[1]);
      if (cells.length >= 9) {
        docs.push({
          tipoDte: parseInt(cells[0], 10),
          folio: parseInt(cells[1], 10),
          fecha: cells[2],
          receptorNombre: cells[3],
          receptorRut: cells[4],
          montoNeto: parseInt(cells[5].replace(/\./g, ''), 10),
          iva: parseInt(cells[6].replace(/\./g, ''), 10),
          total: parseInt(cells[7].replace(/\./g, ''), 10),
          estadoSii: cells[8],
        });
      }
    }
    return docs;
  }

  private parseDocumentosRecibidos(snapshot: string, limit: number): DocumentoRecibido[] {
    const rowRegex = /\[row\](.*?)\[\/row\]/gs;
    const docs: DocumentoRecibido[] = [];
    let rowMatch;
    while ((rowMatch = rowRegex.exec(snapshot)) !== null && docs.length < limit) {
      const cells: string[] = [];
      let cellMatch;
      const cellRe = /\[cell "([^"]*)"\]/g;
      while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) cells.push(cellMatch[1]);
      if (cells.length >= 9) {
        docs.push({
          tipoDte: parseInt(cells[0], 10),
          folio: parseInt(cells[1], 10),
          fecha: cells[2],
          emisorNombre: cells[3],
          emisorRut: cells[4],
          montoNeto: parseInt(cells[5].replace(/\./g, ''), 10),
          iva: parseInt(cells[6].replace(/\./g, ''), 10),
          total: parseInt(cells[7].replace(/\./g, ''), 10),
          estadoRecepcion: cells[8],
        });
      }
    }
    return docs;
  }

  private parseLineasDetalle(snapshot: string): LineaDetalle[] {
    const rowRegex = /\[detalle-row\](.*?)\[\/detalle-row\]/gs;
    const lineas: LineaDetalle[] = [];
    let match;
    while ((match = rowRegex.exec(snapshot)) !== null) {
      const cells: string[] = [];
      let cellMatch;
      const cellRe = /\[cell "([^"]*)"\]/g;
      while ((cellMatch = cellRe.exec(match[1])) !== null) cells.push(cellMatch[1]);
      if (cells.length >= 4) {
        lineas.push({
          descripcion: cells[0],
          cantidad: parseFloat(cells[1]),
          precioUnitario: parseInt(cells[2].replace(/\./g, ''), 10),
          descuento: parseFloat(cells[3]),
        });
      }
    }
    return lineas;
  }

  private findRef(snapshot: string, pattern: RegExp): string | null {
    const regex = /(@e\d+)[^\]]*"([^"]*)"/g;
    let match;
    while ((match = regex.exec(snapshot)) !== null) {
      if (pattern.test(match[2])) return match[1];
    }
    return null;
  }
}
