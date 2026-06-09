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

const MIPYME_EMITIDOS_URL = 'https://www4.sii.cl/consemitidosinternetui/#/defaultInternet';
const MIPYME_RECIBIDOS_URL = 'https://www4.sii.cl/consemitidosinternetui/#/dterecibidosInternet';

export class MipymeScraper {
  constructor(
    private browser: Browser,
    private session: SessionManager
  ) {}

  async listEmpresas(): Promise<Empresa[]> {
    const session = await this.session.getSession();
    const snapshot = this.browser.snapshot();
    const empresas = this.parseEmpresas(snapshot);
    if (empresas.length === 0) {
      return [{ rut: session.empresaRut, nombre: session.empresaNombre }];
    }
    return empresas;
  }

  async listDocumentosEmitidos(filtros: FiltrosEmitidos): Promise<DocumentoEmitido[]> {
    return this.withReauth(async () => {
      await this.ensureEmpresa(filtros.empresaRut);
      this.browser.open(MIPYME_EMITIDOS_URL);
      await this.applyFiltrosEmitidos(filtros);
      this.browser.waitFor('DTE de ventas emitidos');
      const summary = this.browser.snapshot();

      const typeLinks = this.parseSummaryTypeLinks(summary);
      if (typeLinks.length === 0) return [];

      const docs: DocumentoEmitido[] = [];
      const limit = filtros.limit ?? 50;
      for (const link of typeLinks) {
        if (docs.length >= limit) break;
        this.browser.click(link.ref);
        this.browser.waitFor('Folio');
        const docSnapshot = this.browser.snapshot();
        docs.push(...this.parseDocumentosEmitidos(docSnapshot, limit - docs.length, link.tipoDte));
      }
      return docs;
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
      this.browser.waitFor('Folio');
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
    // El nuevo portal tiene comboboxes: [0]=empresa, [1]=mes, [2]=año + botón Consultar
    const comboRefs = [...snapshot.matchAll(/combobox \[[^\]]*ref=(e\d+)\]/g)].map(m => m[1]);
    const session = await this.session.getSession();
    const empresaRut = filtros.empresaRut ?? session.empresaRut;
    const fecha = filtros.fechaDesde ? new Date(filtros.fechaDesde + 'T00:00:00') : new Date();
    const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    if (comboRefs[0]) this.browser.select(comboRefs[0], empresaRut);
    if (comboRefs[1]) this.browser.select(comboRefs[1], MESES[fecha.getMonth()]);
    if (comboRefs[2]) this.browser.select(comboRefs[2], String(fecha.getFullYear()));
    const btnRef = this.findRef(snapshot, /consultar/i);
    if (btnRef) this.browser.click(btnRef);
  }

  private async applyFiltrosRecibidos(filtros: FiltrosRecibidos): Promise<void> {
    const snapshot = this.browser.snapshot();
    const comboRefs = [...snapshot.matchAll(/combobox \[[^\]]*ref=(e\d+)\]/g)].map(m => m[1]);
    const session = await this.session.getSession();
    const empresaRut = filtros.empresaRut ?? session.empresaRut;
    const fecha = filtros.fechaDesde ? new Date(filtros.fechaDesde + 'T00:00:00') : new Date();
    const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    if (comboRefs[0]) this.browser.select(comboRefs[0], empresaRut);
    if (comboRefs[1]) this.browser.select(comboRefs[1], MESES[fecha.getMonth()]);
    if (comboRefs[2]) this.browser.select(comboRefs[2], String(fecha.getFullYear()));
    const btnRef = this.findRef(snapshot, /consultar/i);
    if (btnRef) this.browser.click(btnRef);
  }

  private parseEmpresas(snapshot: string): Empresa[] {
    const regex = /option "(\d{5,}-[0-9Kk])" /g;
    const empresas: Empresa[] = [];
    let match;
    while ((match = regex.exec(snapshot)) !== null) {
      empresas.push({ rut: match[1], nombre: match[1] });
    }
    return empresas;
  }

  private parseSummaryTypeLinks(snapshot: string): Array<{ ref: string; tipoDte: number }> {
    const links: Array<{ ref: string; tipoDte: number }> = [];
    const regex = /link "([^"]+\((\d+)\))" \[ref=(e\d+)\]/g;
    let match;
    while ((match = regex.exec(snapshot)) !== null) {
      links.push({ ref: match[3], tipoDte: parseInt(match[2], 10) });
    }
    return links;
  }

  private parseDocumentosEmitidos(snapshot: string, limit: number, tipoDte = 0): DocumentoEmitido[] {
    const docs: DocumentoEmitido[] = [];
    const lines = snapshot.split('\n');

    let i = 0;
    while (i < lines.length && docs.length < limit) {
      const line = lines[i];
      const rowMatch = line.match(/^(\s+)- row$/);
      if (!rowMatch) { i++; continue; }

      const rowIndent = rowMatch[1].length;
      const cellIndent = rowIndent + 2;

      // Recopilar celdas al nivel exacto del hijo directo del row
      const cells: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const cl = lines[j];
        // Salir si estamos al nivel del row o más arriba
        if (cl.length > 0 && !cl.startsWith(' '.repeat(rowIndent + 1))) break;
        // Solo procesar celdas al nivel cellIndent
        if (cl.startsWith(' '.repeat(cellIndent) + '- ')) {
          const t = cl.trim();
          if (t.startsWith('- cell "')) {
            const m = t.match(/^- cell "([^"]*)"/);
            if (m) cells.push(m[1]);
          } else if (/^- cell\s*$/.test(t)) {
            cells.push('');
          }
        }
        j++;
      }
      i = j;

      // Fila válida: ≥9 celdas, primera celda es número secuencial (no es fila de totales)
      if (cells.length >= 9 && /^\d+$/.test(cells[0])) {
        docs.push({
          tipoDte,
          receptorRut: cells[1],
          folio: parseInt(cells[2], 10),
          fecha: cells[3],                              // dd/mm/yyyy
          receptorNombre: cells[1],
          montoNeto: parseInt(cells[5].replace(/\./g, ''), 10) || 0,
          iva: parseInt(cells[7].replace(/\./g, ''), 10) || 0,
          total: parseInt(cells[8].replace(/\./g, ''), 10) || 0,
          estadoSii: cells[9] ?? '',
        });
      }
    }
    return docs;
  }

  private parseDocumentosRecibidos(snapshot: string, limit: number): DocumentoRecibido[] {
    const docs: DocumentoRecibido[] = [];
    const lines = snapshot.split('\n');

    let i = 0;
    while (i < lines.length && docs.length < limit) {
      const line = lines[i];
      const rowMatch = line.match(/^(\s+)- row$/);
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
          if (t.startsWith('- cell "')) {
            const m = t.match(/^- cell "([^"]*)"/);
            if (m) cells.push(m[1]);
          } else if (/^- cell\s*$/.test(t)) {
            cells.push('');
          }
        }
        j++;
      }
      i = j;

      // Fila válida: ≥9 celdas, primera celda es número secuencial
      if (cells.length >= 9 && /^\d+$/.test(cells[0])) {
        docs.push({
          tipoDte: 0,
          emisorRut: cells[1],
          folio: parseInt(cells[2], 10),
          fecha: cells[3],
          emisorNombre: cells[1],
          montoNeto: parseInt(cells[5].replace(/\./g, ''), 10) || 0,
          iva: parseInt(cells[7].replace(/\./g, ''), 10) || 0,
          total: parseInt(cells[8].replace(/\./g, ''), 10) || 0,
          estadoRecepcion: cells[9] ?? '',
        });
      }
    }
    return docs;
  }

  private parseLineasDetalle(snapshot: string): LineaDetalle[] {
    const lineas: LineaDetalle[] = [];
    const lines = snapshot.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const rowMatch = line.match(/^(\s+)- row$/);
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
          if (t.startsWith('- cell "')) {
            const m = t.match(/^- cell "([^"]*)"/);
            if (m) cells.push(m[1]);
          } else if (/^- cell\s*$/.test(t)) {
            cells.push('');
          }
        }
        j++;
      }
      i = j;

      if (cells.length >= 4 && isNaN(parseInt(cells[0], 10)) && cells[0] !== '') {
        lineas.push({
          descripcion: cells[0],
          cantidad: parseFloat(cells[1]) || 0,
          precioUnitario: parseInt(cells[2].replace(/\./g, ''), 10) || 0,
          descuento: parseFloat(cells[3]) || 0,
        });
      }
    }
    return lineas;
  }

  private findRef(snapshot: string, pattern: RegExp): string | null {
    for (const line of snapshot.split('\n')) {
      const refMatch = line.match(/ref=(e\d+)/);
      if (refMatch && pattern.test(line)) {
        return refMatch[1];
      }
    }
    return null;
  }
}
