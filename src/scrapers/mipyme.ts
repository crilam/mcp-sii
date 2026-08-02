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

export interface MipymeDteEmitido {
  tipoDte: number;
  tipoDteNombre: string;
  folio: number;
  fecha: string;
  receptorRut: string;
  receptorNombre: string;
  monto: number;
  estado: string;
}

export interface FiltrosMipymeDteEmitidos {
  empresaRut?: string;
  tipoDte?: number;
  fechaDesde?: string;
  fechaHasta?: string;
  receptorRut?: string;
  folio?: number;
  limit?: number;
}

export interface LineaDte {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
}

export interface EmitirDteParams {
  empresaRut?: string;
  tipoDte: number;
  receptorRut: string;
  receptorDv: string;
  lineas: LineaDte[];
}

export interface DteEmitidoResult {
  folio: number;
  tipoDte: number;
  receptorRut: string;
  total: number;
}

const MIPYME_EMITIDOS_URL = 'https://www4.sii.cl/consemitidosinternetui/#/defaultInternet';
const MIPYME_RECIBIDOS_URL = 'https://www4.sii.cl/consemitidosinternetui/#/dterecibidosInternet';
const MIPYME_CGI_BASE = 'https://www1.sii.cl/cgi-bin/Portal001';
const MIPYME_PORTAL_URL = `${MIPYME_CGI_BASE}/mipeSelEmpresa.cgi`;
const MIPYME_HISTORIAL_URL = `${MIPYME_CGI_BASE}/mipeAdminDocsEmi.cgi`;
const MIPYME_EMISION_URL = `${MIPYME_CGI_BASE}/mipeDocAlta.cgi`;

const TIPO_DTE_NOMBRES: Record<string, number> = {
  'Factura Electronica': 33,
  'Factura No afecta o exenta': 34,
  'Nota de Credito': 61,
  'Nota de Debito': 56,
  'Guia de Despacho': 52,
  'Factura de Compra': 46,
};

export class MipymeScraper {
  constructor(
    private browser: Browser,
    private session: SessionManager
  ) {}

  async listEmpresas(): Promise<Empresa[]> {
    const empresas = await this.session.listEmpresasDisponibles();
    if (empresas.length === 0) {
      // listEmpresasDisponibles() y getSession()/selectEmpresa() parsean el
      // mismo combo de la misma página de selección de empresa. Si acá vino
      // vacío, ahí también viene vacío: getSession() no puede caer en el
      // camino de "opera N empresas, pasá empresa_rut" (ese exige >1 opciones
      // parseadas), así que no hace falta manejarlo aparte en esta tool —que
      // además no recibe empresa_rut, así que ese mensaje sería confuso acá.
      // Sólo queda el caso real: una única empresa implícita en la sesión.
      const session = await this.session.getSession();
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

  async getDocumentoEmitido(tipoDte: number, folio: number, empresaRut?: string, fecha?: string): Promise<DocumentoEmitidoDetalle> {
    return this.withReauth(async () => {
      await this.ensureEmpresa(empresaRut);
      // Se pasa empresaRut explícitamente en vez de confiar en que ensureEmpresa
      // ya dejó la sesión en la empresa correcta: ese orden es un invariante
      // implícito que un reordenamiento futuro rompería en silencio, contra la
      // empresa equivocada. getSession() es idempotente si ya está ahí.
      const session = await this.session.getSession(empresaRut);
      const rutToUse = empresaRut ?? session.empresaRut;

      this.browser.open(MIPYME_EMITIDOS_URL);
      await this.applyFiltrosEmitidos({ empresaRut: rutToUse, fechaDesde: fecha });
      this.browser.waitFor('DTE de ventas emitidos');
      const summary = this.browser.snapshot();

      const typeLinks = this.parseSummaryTypeLinks(summary);
      const typeLink = typeLinks.find(l => l.tipoDte === tipoDte);
      if (!typeLink) throw new Error(`No se encontraron documentos tipo ${tipoDte} en el período`);

      this.browser.click(typeLink.ref);
      this.browser.waitFor('Folio');
      const listSnapshot = this.browser.snapshot();

      const folioRef = this.findFolioLinkRef(listSnapshot, folio);
      if (!folioRef) throw new Error(`Folio ${folio} no encontrado en tipo ${tipoDte}`);

      this.browser.click(folioRef);
      this.browser.waitFor('Total documentos');
      const detailSnapshot = this.browser.snapshot();

      const docs = this.parseDocumentosEmitidos(detailSnapshot, 1, tipoDte);
      if (docs.length === 0) throw new Error(`No se encontró el documento tipo ${tipoDte} folio ${folio}`);

      return { ...docs[0], lineas: [] };
    });
  }

  async listDocumentosRecibidos(filtros: FiltrosRecibidos): Promise<DocumentoRecibido[]> {
    return this.withReauth(async () => {
      await this.ensureEmpresa(filtros.empresaRut);
      this.browser.open(MIPYME_RECIBIDOS_URL);
      await this.navegarATabRecibidos();
      await this.applyFiltrosRecibidos(filtros);
      this.browser.waitForAny(['No hay documentos', 'Tipo Documento']);
      const summary = this.browser.snapshot();
      if (summary.includes('No hay documentos')) return [];

      const typeLinks = this.parseSummaryTypeLinks(summary);
      if (typeLinks.length === 0) return [];

      const docs: DocumentoRecibido[] = [];
      const limit = filtros.limit ?? 50;
      for (const link of typeLinks) {
        if (docs.length >= limit) break;
        this.browser.click(link.ref);
        this.browser.waitFor('Folio');
        const docSnapshot = this.browser.snapshot();
        docs.push(...this.parseDocumentosRecibidos(docSnapshot, limit - docs.length, link.tipoDte));
      }
      return docs;
    });
  }

  async getDocumentoRecibido(tipoDte: number, folio: number, emisorRut: string, empresaRut?: string, fecha?: string): Promise<DocumentoRecibidoDetalle> {
    return this.withReauth(async () => {
      await this.ensureEmpresa(empresaRut);
      // Ídem getDocumentoEmitido: empresaRut explícito en vez de depender del
      // orden de llamadas para no reabrir el mismo bug si alguien reordena.
      const session = await this.session.getSession(empresaRut);
      const rutToUse = empresaRut ?? session.empresaRut;

      this.browser.open(MIPYME_RECIBIDOS_URL);
      await this.navegarATabRecibidos();
      await this.applyFiltrosRecibidos({ empresaRut: rutToUse, fechaDesde: fecha });
      this.browser.waitForAny(['No hay documentos', 'Tipo Documento']);
      const summary = this.browser.snapshot();
      if (summary.includes('No hay documentos')) throw new Error(`No hay documentos recibidos en el período para folio ${folio}`);

      const typeLinks = this.parseSummaryTypeLinks(summary);
      const typeLink = typeLinks.find(l => l.tipoDte === tipoDte);
      if (!typeLink) throw new Error(`No se encontraron documentos tipo ${tipoDte} en el período`);

      this.browser.click(typeLink.ref);
      this.browser.waitFor('Folio');
      const listSnapshot = this.browser.snapshot();

      const folioRef = this.findFolioLinkRef(listSnapshot, folio);
      if (!folioRef) throw new Error(`Folio ${folio} no encontrado de emisor ${emisorRut}`);

      this.browser.click(folioRef);
      this.browser.waitFor('Total documentos');
      const detailSnapshot = this.browser.snapshot();

      const docs = this.parseDocumentosRecibidos(detailSnapshot, 1, tipoDte);
      if (docs.length === 0) throw new Error(`No se encontró el documento tipo ${tipoDte} folio ${folio} de ${emisorRut}`);

      return { ...docs[0], lineas: [] };
    });
  }

  async listMipymeDteEmitidos(filtros: FiltrosMipymeDteEmitidos): Promise<MipymeDteEmitido[]> {
    return this.withReauth(async () => {
      await this.ensureMipymePortalEmpresa(filtros.empresaRut);
      const url = this.buildHistorialUrl(filtros);
      this.browser.open(url);
      this.browser.waitForAny(['No existen documentos', 'Receptor RUT']);
      const snapshot = this.browser.snapshot();
      if (snapshot.includes('No existen documentos')) return [];
      return this.parseMipymeDteEmitidos(snapshot, filtros.limit ?? 50);
    });
  }

  async emitirDte(params: EmitirDteParams): Promise<DteEmitidoResult> {
    return this.withReauth(async () => {
      await this.ensureMipymePortalEmpresa(params.empresaRut);
      this.browser.open(`${MIPYME_EMISION_URL}?TPO_DOC=${params.tipoDte}`);
      this.browser.waitFor('Receptor');

      let snapshot = this.browser.snapshot();
      const rutRef = this.findRef(snapshot, /RUT.*Receptor|Rut Receptor/i);
      const dvRef = this.findRef(snapshot, /\bDV\b/);
      if (rutRef) this.browser.fill(rutRef, params.receptorRut);
      if (dvRef) this.browser.fill(dvRef, params.receptorDv);

      for (let idx = 0; idx < params.lineas.length; idx++) {
        const linea = params.lineas[idx];
        snapshot = this.browser.snapshot();
        const descRef = this.findRef(snapshot, /Descripci/i);
        const cantRef = this.findRef(snapshot, /Cantidad/i);
        const precioRef = this.findRef(snapshot, /Precio/i);
        if (descRef) this.browser.fill(descRef, linea.descripcion);
        if (cantRef) this.browser.fill(cantRef, String(linea.cantidad));
        if (precioRef) this.browser.fill(precioRef, String(linea.precioUnitario));
        if (idx < params.lineas.length - 1) {
          const addRef = this.findRef(snapshot, /Agrega.*linea/i);
          if (addRef) this.browser.click(addRef);
          this.browser.waitFor('Descripci');
        }
      }

      snapshot = this.browser.snapshot();
      const validarRef = this.findRef(snapshot, /Validar/i);
      if (!validarRef) throw new Error('No se encontró el botón "Validar y visualizar"');
      this.browser.click(validarRef);
      this.browser.waitFor('Emitir');

      snapshot = this.browser.snapshot();
      const emitirRef = this.findRef(snapshot, /\bEmitir\b/);
      if (!emitirRef) throw new Error('No se encontró el botón "Emitir"');
      this.browser.click(emitirRef);
      this.browser.waitFor('Folio');

      snapshot = this.browser.snapshot();
      return this.parseDteEmitidoResult(snapshot, params.tipoDte);
    });
  }

  private async withReauth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/sesion|session|autenticacion|unauthorized|401/i.test(msg)) {
        this.session.invalidate();
        // No se llama a getSession() acá: `fn()` ya vuelve a llamar
        // ensureEmpresa(empresaRut) con la empresa correcta al reintentar.
        // Llamarlo sin argumento antes del reintento (como se hacía) es
        // redundante en el caso simple y, con varias empresas y sin
        // SII_EMPRESA_RUT, revienta con "opera N empresas" aunque el
        // llamador sí haya pasado empresa_rut — enmascarando el error real
        // de sesión expirada y perdiendo el reintento.
        return fn();
      }
      throw err;
    }
  }

  // El cambio de empresa (si corresponde) lo hace SessionManager, único dueño
  // de la sesión: abrir una selección de empresa por fuera de la sesión que
  // administra el login duplicaría ese estado y podría desalinearse de la
  // sesión real, sin ganar nada.
  private async ensureEmpresa(empresaRut?: string): Promise<void> {
    await this.session.getSession(empresaRut);
  }

  private async applyFiltrosEmitidos(filtros: FiltrosEmitidos): Promise<void> {
    const snapshot = this.browser.snapshot();
    // El nuevo portal tiene comboboxes: [0]=empresa, [1]=mes, [2]=año + botón Consultar
    const comboRefs = [...snapshot.matchAll(/combobox \[[^\]]*ref=(e\d+)\]/g)].map(m => m[1]);
    // empresaRut explícito: no depender de que ensureEmpresa se haya llamado
    // antes en esta misma pasada para dejar la sesión en la empresa pedida.
    const session = await this.session.getSession(filtros.empresaRut);
    const empresaRut = filtros.empresaRut ?? session.empresaRut;
    const fecha = filtros.fechaDesde ? new Date(filtros.fechaDesde + 'T00:00:00') : new Date();
    const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    if (comboRefs[0]) this.browser.select(comboRefs[0], empresaRut);
    if (comboRefs[1]) this.browser.select(comboRefs[1], MESES[fecha.getMonth()]);
    if (comboRefs[2]) this.browser.select(comboRefs[2], String(fecha.getFullYear()));
    const btnRef = this.findRef(snapshot, /consultar/i);
    if (btnRef) this.browser.click(btnRef);
  }

  private async navegarATabRecibidos(): Promise<void> {
    this.browser.waitFor('DTE Recibidos');
    const tabRef = this.findRef(this.browser.snapshot(), /DTE Recibidos/);
    if (tabRef) this.browser.click(tabRef);
    this.browser.waitFor('CONSULTA DTE RECIBIDOS');
  }

  private async applyFiltrosRecibidos(filtros: FiltrosRecibidos): Promise<void> {
    const snapshot = this.browser.snapshot();
    const comboRefs = [...snapshot.matchAll(/combobox \[[^\]]*ref=(e\d+)\]/g)].map(m => m[1]);
    // Ídem applyFiltrosEmitidos: empresaRut explícito, no por orden implícito.
    const session = await this.session.getSession(filtros.empresaRut);
    const empresaRut = filtros.empresaRut ?? session.empresaRut;
    const fecha = filtros.fechaDesde ? new Date(filtros.fechaDesde + 'T00:00:00') : new Date();
    const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    if (comboRefs[0]) this.browser.select(comboRefs[0], empresaRut);
    if (comboRefs[1]) this.browser.select(comboRefs[1], MESES[fecha.getMonth()]);
    if (comboRefs[2]) this.browser.select(comboRefs[2], String(fecha.getFullYear()));
    const btnRef = this.findRef(snapshot, /consultar/i);
    if (btnRef) this.browser.click(btnRef);
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

  private parseDocumentosRecibidos(snapshot: string, limit: number, tipoDte = 0): DocumentoRecibido[] {
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
          tipoDte,
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

  private findFolioLinkRef(snapshot: string, folio: number): string | null {
    const m = snapshot.match(new RegExp(`link "${folio}" \\[ref=(e\\d+)\\]`));
    return m ? m[1] : null;
  }

private async ensureMipymePortalEmpresa(empresaRut?: string): Promise<void> {
    const session = await this.session.getSession(empresaRut);
    const rutToUse = empresaRut ?? session.empresaRut;
    this.browser.open(MIPYME_PORTAL_URL);
    this.browser.waitFor(rutToUse);
    const snapshot = this.browser.snapshot();
    const comboRef = this.findRef(snapshot, /combobox/);
    if (comboRef) this.browser.select(comboRef, rutToUse);
    const btnRef = this.findRef(snapshot, /ingresar|acceder/i);
    if (btnRef) this.browser.click(btnRef);
  }

  private buildHistorialUrl(filtros: FiltrosMipymeDteEmitidos): string {
    const params = new URLSearchParams({
      RUT_RECP: filtros.receptorRut ?? '',
      FOLIO: filtros.folio ? String(filtros.folio) : '',
      RZN_SOC: '',
      FEC_DESDE: filtros.fechaDesde ? this.toSiiDate(filtros.fechaDesde) : '',
      FEC_HASTA: filtros.fechaHasta ? this.toSiiDate(filtros.fechaHasta) : '',
      TPO_DOC: filtros.tipoDte ? String(filtros.tipoDte) : '',
      ESTADO: '',
      ORDEN: '',
      NUM_PAG: '1',
    });
    return `${MIPYME_HISTORIAL_URL}?${params}`;
  }

  private toSiiDate(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  private parseMipymeDteEmitidos(snapshot: string, limit: number): MipymeDteEmitido[] {
    const docs: MipymeDteEmitido[] = [];
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
          // - cell [ref=eN] (sin texto) → ignorado intencionalmente (columna "Ver")
        }
        j++;
      }
      i = j;

      // cells: [0]=receptorRut [1]=receptorNombre [2]=tipoDteNombre [3]=folio [4]=fecha [5]=monto [6]=estado
      if (cells.length >= 7 && /^\d+$/.test(cells[3])) {
        docs.push({
          tipoDte: TIPO_DTE_NOMBRES[cells[2]] ?? 0,
          tipoDteNombre: cells[2],
          folio: parseInt(cells[3], 10),
          fecha: cells[4],
          receptorRut: cells[0],
          receptorNombre: cells[1],
          monto: parseInt(cells[5].replace(/\./g, ''), 10) || 0,
          estado: cells[6],
        });
      }
    }
    return docs;
  }

  private parseDteEmitidoResult(snapshot: string, tipoDte: number): DteEmitidoResult {
    const folioMatch = snapshot.match(/Folio[:\s]+(\d+)/i);
    const totalMatch = snapshot.match(/Total[:\s]+([\d.]+)/i);
    const receptorMatch = snapshot.match(/Receptor[:\s]+([\d]+-[0-9Kk])/i);
    return {
      folio: folioMatch ? parseInt(folioMatch[1], 10) : 0,
      tipoDte,
      receptorRut: receptorMatch ? receptorMatch[1] : '',
      total: totalMatch ? parseInt(totalMatch[1].replace(/\./g, ''), 10) : 0,
    };
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
