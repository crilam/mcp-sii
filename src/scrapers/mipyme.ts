import { Browser } from '../browser';
import { Empresa, SessionManager } from '../session';

// Este scraper cubre SÓLO el portal mipyme (los CGI de www1.sii.cl/cgi-bin/Portal001):
// listado de empresas, historial de DTE emitidos y emisión.
//
// Hasta el 2026-08-03 tenía además cuatro métodos que consultaban
// `consemitidosinternetui` (listDocumentosEmitidos/Recibidos y sus detalles).
// Se borraron: esa aplicación se consulta por HTTP en `DteScraper` desde la
// migración de `sii_dte_*`, ninguna tool llamaba a los métodos del navegador, y
// tener dos caminos para la misma consulta invitaba a arreglar el equivocado.
// Los contratos HTTP de este portal están relevados en
// docs/superpowers/specs/2026-08-03-mipyme-http-contratos.md.

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

const MIPYME_CGI_BASE = 'https://www1.sii.cl/cgi-bin/Portal001';
const MIPYME_PORTAL_URL = `${MIPYME_CGI_BASE}/mipeSelEmpresa.cgi`;
const MIPYME_HISTORIAL_URL = `${MIPYME_CGI_BASE}/mipeAdminDocsEmi.cgi`;
// ATENCIÓN: esta ruta NO existe. Medido el 2026-08-03 con sesión autenticada,
// `mipeDocAlta.cgi` responde 404, así que `emitirDte` no puede estar
// funcionando. El portal lanza la emisión con
// `mipeLaunchPage.cgi?OPCION=<tipoDte>&TIPO=4`, que a su vez abre
// `mipeGenFacEx.cgi?PTDC_CODIGO=<tipoDte>`. Se deja la constante como estaba
// —sin "arreglarla" a ciegas— porque cambiar la URL sin relevar el formulario
// que sirve convertiría un fallo visible en un camino que emite documentos
// tributarios reales con parámetros adivinados. Ver el spec de contratos.
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
    // También navega el mismo navegador compartido (la página de selección de
    // empresa), así que va dentro de la misma cola que el resto.
    return this.session.conEmpresaExclusiva(() => this.listEmpresasInterno());
  }

  private async listEmpresasInterno(): Promise<Empresa[]> {
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

  // Toda operación del portal pasa por acá, así que es el único lugar donde
  // hace falta tomar la exclusión: cubre el ciclo entero (seleccionar empresa
  // → navegar → leer) y también el reintento por sesión expirada, que vuelve a
  // seleccionar. Envolver sólo la selección dejaría las lecturas fuera de la
  // sección crítica, que es exactamente el bug.
  //
  // El candado NO es una herencia del navegador: medido el 2026-08-03, el POST
  // de selección de empresa del CGI no cambia ninguna cookie —la empresa activa
  // es estado del lado del servidor, atado a CSESSIONID—, así que dos consultas
  // con empresas distintas se pisan igual por HTTP. Al migrar, la serialización
  // se conserva.
  private async withReauth<T>(fn: () => Promise<T>): Promise<T> {
    return this.session.conEmpresaExclusiva(() => this.intentarConReauth(fn));
  }

  private async intentarConReauth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/sesion|session|autenticacion|unauthorized|401/i.test(msg)) {
        this.session.invalidate();
        // No se llama a getSession() acá: `fn()` ya vuelve a llamar
        // ensureMipymePortalEmpresa(empresaRut) con la empresa correcta al
        // reintentar. Llamarlo sin argumento antes del reintento (como se
        // hacía) es redundante en el caso simple y, con varias empresas y sin
        // SII_EMPRESA_RUT, revienta con "opera N empresas" aunque el llamador
        // sí haya pasado empresa_rut — enmascarando el error real de sesión
        // expirada y perdiendo el reintento.
        return fn();
      }
      throw err;
    }
  }

  // El cambio de empresa (si corresponde) lo hace SessionManager, único dueño
  // de la sesión: abrir una selección de empresa por fuera de la sesión que
  // administra el login duplicaría ese estado y podría desalinearse de la
  // sesión real, sin ganar nada.
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
