import { Browser } from './browser';
import { AuthStrategy, SiiConfig } from './env';

export interface Empresa {
  rut: string;
  nombre: string;
}

export interface SiiSession {
  empresaRut: string;
  empresaNombre: string;
}

const SII_MIPYME_URL = 'https://www4.sii.cl/mipymesinternetui/pages/index.xhtml';
const SII_LOGIN_URL = 'https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html';
const SII_CERT_URL = 'https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoCertificado.html';

export class SessionManager {
  private session: SiiSession | null = null;

  constructor(
    private config: SiiConfig,
    private browser: Browser
  ) {}

  async login(): Promise<SiiSession> {
    this.browser.open(this.config.strategy === AuthStrategy.Clave ? SII_LOGIN_URL : SII_CERT_URL);
    const loginSnapshot = this.browser.snapshot();

    if (this.config.strategy === AuthStrategy.Clave) {
      await this.fillClaveForm(loginSnapshot);
    }

    const session = await this.selectEmpresa();
    this.session = session;
    return session;
  }

  async getSession(): Promise<SiiSession> {
    if (!this.session) {
      return this.login();
    }
    return this.session;
  }

  invalidate(): void {
    this.session = null;
  }

  private async fillClaveForm(snapshot: string): Promise<void> {
    const rutRef = this.findRef(snapshot, /rut|run/i) ?? '@e1';
    const claveRef = this.findRef(snapshot, /clave|contraseña|password/i) ?? '@e2';
    const btnRef = this.findRef(snapshot, /ingresar|entrar|login/i) ?? '@e3';

    this.browser.fill(rutRef, this.config.rut);
    this.browser.fill(claveRef, this.config.clave!);
    this.browser.click(btnRef);
  }

  private async selectEmpresa(): Promise<SiiSession> {
    const snapshot = this.browser.snapshot();

    const empresas = this.parseEmpresas(snapshot);

    if (empresas.length === 0) {
      throw new Error('No se encontraron empresas disponibles para este usuario');
    }

    if (empresas.length === 1) {
      const empresa = empresas[0];
      const selectRef = this.findRef(snapshot, /empresa/i) ?? '@e10';
      this.browser.select(selectRef, empresa.rut);
      return { empresaRut: empresa.rut, empresaNombre: empresa.nombre };
    }

    if (!this.config.empresaRut) {
      const lista = empresas.map(e => `${e.rut} — ${e.nombre}`).join(', ');
      throw new Error(
        `Esta persona opera ${empresas.length} empresas. Configura SII_EMPRESA_RUT con uno de: ${lista}`
      );
    }

    const empresa = empresas.find(e => e.rut === this.config.empresaRut);
    if (!empresa) {
      throw new Error(`Empresa ${this.config.empresaRut} no encontrada. Disponibles: ${empresas.map(e => e.rut).join(', ')}`);
    }

    const selectRef = this.findRef(snapshot, /empresa/i) ?? '@e10';
    this.browser.select(selectRef, empresa.rut);
    return { empresaRut: empresa.rut, empresaNombre: empresa.nombre };
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

  private findRef(snapshot: string, pattern: RegExp): string | null {
    const regex = /(@e\d+)[^\]]*"([^"]*)"/g;
    let match;
    while ((match = regex.exec(snapshot)) !== null) {
      if (pattern.test(match[2])) return match[1];
    }
    return null;
  }
}
