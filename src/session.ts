import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

const SII_MIPYME_URL = 'https://mipyme.sii.cl/';
// mipyme.sii.cl solo sirve como `referencia` del CGI de autenticación: navegar a
// esa raíz devuelve 404 (y sus subrutas, un rechazo del WAF). La selección de
// empresa vive en el CGI del portal.
const SII_SEL_EMPRESA_URL = 'https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi';
const SII_LOGIN_URL = 'https://zeusr.sii.cl//AUT2000/InicioAutenticacion/IngresoRutClave.html';
const SII_CERT_CGI = 'https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi';

// Nombres de cookies de sesión que el SII establece tras autenticación.
const SII_SESSION_COOKIES = [
  'NETSCAPE_LIVEWIRE.rut',
  'NETSCAPE_LIVEWIRE.rutm',
  'NETSCAPE_LIVEWIRE.dv',
  'NETSCAPE_LIVEWIRE.dvm',
  'NETSCAPE_LIVEWIRE.clave',
  'NETSCAPE_LIVEWIRE.mac',
  'NETSCAPE_LIVEWIRE.exp',
  'NETSCAPE_LIVEWIRE.sec',
  'NETSCAPE_LIVEWIRE.lms',
  'TOKEN',
  'CSESSIONID',
  'DV_NS',
  'RUT_NS',
];

// Los .pfx del SII usan cifrado legacy (RC2), que solo OpenSSL 3.x descifra con
// -legacy. El `openssl` del PATH en macOS es LibreSSL, que ni siquiera acepta
// ese flag, así que hay que buscar un binario OpenSSL 3.x real.
const OPENSSL_CANDIDATES = [
  '/opt/homebrew/opt/openssl@3/bin/openssl',
  '/usr/local/opt/openssl@3/bin/openssl',
  'openssl',
];

let opensslBin: string | null = null;

function resolveOpensslBin(): string {
  if (opensslBin) return opensslBin;

  const candidates = process.env.SII_OPENSSL_BIN
    ? [process.env.SII_OPENSSL_BIN]
    : OPENSSL_CANDIDATES;

  for (const bin of candidates) {
    try {
      const version = execSync(`"${bin}" version`, {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (/^OpenSSL 3/.test(version.trim())) {
        opensslBin = bin;
        return bin;
      }
    } catch {
      // Candidato inexistente o no ejecutable: seguir con el siguiente.
    }
  }

  throw new Error(
    'No se encontró OpenSSL 3.x, necesario para leer el certificado .pfx del SII ' +
    '(el `openssl` de macOS es LibreSSL y no soporta -legacy). ' +
    'Instalalo con `brew install openssl@3` o apuntá SII_OPENSSL_BIN al binario correcto.'
  );
}

export class SessionManager {
  private session: SiiSession | null = null;

  constructor(
    private config: SiiConfig,
    private browser: Browser
  ) {}

  async login(): Promise<SiiSession> {
    await this.authenticate();
    const session = await this.selectEmpresa();
    this.session = session;
    return session;
  }

  // Lista las empresas que la persona puede operar sin exigir que una esté
  // seleccionada: es el paso previo a configurar SII_EMPRESA_RUT, así que no
  // puede depender de getSession() (que falla justamente cuando hay varias).
  async listEmpresasDisponibles(): Promise<Empresa[]> {
    await this.authenticate();
    this.browser.open(SII_SEL_EMPRESA_URL);
    return this.parseEmpresas(this.browser.snapshot());
  }

  private async authenticate(): Promise<void> {
    if (this.config.strategy === AuthStrategy.Certificate) {
      await this.loginWithCert();
    } else {
      this.browser.open(SII_LOGIN_URL);
      const loginSnapshot = this.browser.snapshot();
      await this.fillClaveForm(loginSnapshot);
    }
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

  // Autentica con certificado digital vía curl (TLS mutual auth), luego inyecta
  // las cookies de sesión en agent-browser navegando a un dominio .sii.cl.
  private async loginWithCert(): Promise<void> {
    const { certPath, certPassword } = this.config;
    if (!certPath || !certPassword) {
      throw new Error('loginWithCert requiere SII_CERT_PATH y SII_CERT_PASSWORD');
    }

    const tmpDir = os.tmpdir();
    const certPem = path.join(tmpDir, 'sii_cert.pem');
    const keyPem = path.join(tmpDir, 'sii_key.pem');
    const cookiesFile = path.join(tmpDir, 'sii_cookies.txt');

    // Extraer cert y clave privada del .pfx a PEM temporales (cifrado legacy RC2).
    const openssl = resolveOpensslBin();
    execSync(
      `"${openssl}" pkcs12 -in "${certPath}" -out "${certPem}" -nokeys -legacy -passin pass:"${certPassword}"`,
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    execSync(
      `"${openssl}" pkcs12 -in "${certPath}" -out "${keyPem}" -nocerts -nodes -legacy -passin pass:"${certPassword}"`,
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'ignore', 'pipe'] }
    );

    // TLS mutual auth → obtener cookies de sesión SII.
    execSync(
      `curl -sk --cert "${certPem}" --key "${keyPem}" ` +
      `-c "${cookiesFile}" -b "${cookiesFile}" ` +
      `-L --max-redirs 5 ` +
      `-d "referencia=${SII_MIPYME_URL}" ` +
      `"${SII_CERT_CGI}?${SII_MIPYME_URL}" -o /dev/null`,
      { encoding: 'utf-8', timeout: 30_000 }
    );

    // Parsear cookies del archivo Netscape.
    const cookieMap = this.parseCookieFile(cookiesFile);

    // Limpiar temporales.
    try { fs.unlinkSync(certPem); fs.unlinkSync(keyPem); } catch { /* ignore */ }

    // Inyectar cookies en Chrome: abrir www.sii.cl y setear via document.cookie.
    this.browser.open('https://www.sii.cl');
    for (const name of SII_SESSION_COOKIES) {
      const value = cookieMap[name];
      if (value) {
        this.browser.eval(
          `document.cookie="${name}=${encodeURIComponent(value)};path=/;domain=.sii.cl;secure"`
        );
      }
    }
  }

  // Parsea archivo de cookies en formato Netscape (generado por curl -c).
  private parseCookieFile(filePath: string): Record<string, string> {
    const map: Record<string, string> = {};
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length >= 7) {
          map[parts[5]] = parts[6].trim();
        }
      }
    } catch { /* archivo no existe */ }
    return map;
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
    this.browser.open(SII_SEL_EMPRESA_URL);
    const snapshot = this.browser.snapshot();

    const empresas = this.parseEmpresas(snapshot);

    if (empresas.length === 0) {
      if (this.config.empresaRut) {
        return { empresaRut: this.config.empresaRut, empresaNombre: this.config.empresaRut };
      }
      throw new Error('No se encontraron empresas disponibles. Configura SII_EMPRESA_RUT.');
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
    const submitRef = this.findRef(snapshot, /enviar|aceptar|confirmar/i);
    if (submitRef) this.browser.click(submitRef);
    return { empresaRut: empresa.rut, empresaNombre: empresa.nombre };
  }

  private parseEmpresas(snapshot: string): Empresa[] {
    // Formato portal mipyme: option "NOMBRE EMPRESA RUT-DV" [ref=eN]
    const regex = /option "([^"]+)" /g;
    const empresas: Empresa[] = [];
    let match;
    while ((match = regex.exec(snapshot)) !== null) {
      const text = match[1];
      const withName = text.match(/^(.+?)\s+(\d{5,}-[0-9Kk])$/);
      if (withName) {
        empresas.push({ rut: withName[2], nombre: withName[1].trim() });
      } else if (/^\d{5,}-[0-9Kk]$/.test(text)) {
        empresas.push({ rut: text, nombre: text });
      }
    }
    return empresas;
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
