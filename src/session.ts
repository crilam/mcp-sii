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
const SII_LOGOUT_URL = 'https://zeusr.sii.cl/cgi_AUT2000/autTermino.cgi';
const SEL_EMPRESA_MARKERS = ['SELECCIÓN DE EMPRESA', '- option "'];

// Cookie de expiración que el CGI del SII escribe por JavaScript, con 2 horas
// de vigencia (el mismo valor que usa su propio script de autenticación).
const SII_LOCEXP_COOKIE = 'NETSCAPE_LIVEWIRE.locexp';
const LOCEXP_TTL_MS = 7_200_000;

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
  private authenticated = false;

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
    // Justo después de inyectar las cookies la página puede no haber rendido
    // todavía y el snapshot vuelve sin el combo, devolviendo cero empresas.
    this.browser.waitForAny(SEL_EMPRESA_MARKERS, 20_000);
    const snapshot = this.browser.snapshot();

    // Igual que arriba: si la página no rindió, un listado vacío se confunde
    // con "esta persona no opera ninguna empresa".
    if (!SEL_EMPRESA_MARKERS.some(m => snapshot.includes(m))) {
      throw new Error(
        'La página de selección de empresa no terminó de cargar. Reintentá en unos minutos.'
      );
    }

    return this.parseEmpresas(snapshot);
  }

  // Autentica el RUT persona sin seleccionar empresa. Lo necesitan los portales
  // que cuelgan de la persona y no del contribuyente (p. ej. bienes raíces).
  async authenticateOnly(): Promise<void> {
    return this.authenticate();
  }

  // Cada autenticación abre una sesión nueva en el SII y el servicio limita
  // cuántas puede tener abiertas un RUT a la vez (error 01.01.190.500.720.27).
  // Reautenticar en cada consulta las agota, así que se reusa mientras viva.
  private async authenticate(): Promise<void> {
    if (this.authenticated) return;

    if (this.config.strategy === AuthStrategy.Certificate) {
      await this.loginWithCert();
    } else {
      this.browser.open(SII_LOGIN_URL);
      const loginSnapshot = this.browser.snapshot();
      await this.fillClaveForm(loginSnapshot);
    }

    this.authenticated = true;
  }

  // Cierra la sesión en el SII. Sin esto las sesiones quedan abiertas del lado
  // del servicio hasta que expiran, y se acumulan hasta bloquear el acceso.
  async logout(): Promise<void> {
    if (!this.authenticated) return;

    try {
      this.browser.open(SII_LOGOUT_URL);
    } finally {
      this.authenticated = false;
      this.session = null;
    }
  }

  async getSession(): Promise<SiiSession> {
    if (!this.session) {
      return this.login();
    }
    return this.session;
  }

  // La sesión del SII expiró o fue rechazada: hay que reautenticar, así que el
  // flag de autenticación también se limpia.
  invalidate(): void {
    this.session = null;
    this.authenticated = false;
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

    // El archivo de cookies persiste entre corridas. Mandar las de la sesión
    // anterior con -b hace que el SII las cuente como sesiones acumuladas y
    // responda "Usted ha superado el máximo de sesiones autenticadas"
    // (01.01.190.500.720.27), bloqueando el acceso. Se autentica en limpio.
    try { fs.unlinkSync(cookiesFile); } catch { /* no existía */ }

    // TLS mutual auth → obtener cookies de sesión SII.
    const salida = execSync(
      `curl -sk --cert "${certPem}" --key "${keyPem}" ` +
      `-c "${cookiesFile}" ` +
      `-L --max-redirs 5 ` +
      `-d "referencia=${SII_MIPYME_URL}" ` +
      `"${SII_CERT_CGI}?${SII_MIPYME_URL}"`,
      { encoding: 'utf-8', timeout: 30_000 }
    );

    this.assertAutenticacionExitosa(salida);

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

    this.setLocExpCookie();
  }

  // El CGI responde 200 incluso cuando rechaza la autenticación: el error viene
  // dentro de un alert() de JavaScript. Sin esta comprobación el fallo pasa
  // inadvertido y recién se manifiesta como consultas vacías, muy lejos de la
  // causa. En el éxito la respuesta trae el location.replace al portal.
  private assertAutenticacionExitosa(html: string): void {
    const alerta = html.match(/alert\('([^']+)'/);
    if (alerta) {
      throw new Error(`El SII rechazó la autenticación: ${alerta[1].trim()}`);
    }
    if (!html.includes('location.replace')) {
      throw new Error(
        'El SII no completó la autenticación con certificado (no redirigió al portal).'
      );
    }
  }

  // El CGI de autenticación no manda `locexp` en un Set-Cookie: la escribe por
  // JavaScript en la respuesta, así que curl nunca la ve y hay que replicarla.
  // Sin ella el portal rechaza la sesión aunque el resto de las cookies sea
  // válido, y la autenticación aparenta fallar sin ningún mensaje de error.
  private setLocExpCookie(): void {
    const expira = new Date(Date.now() + LOCEXP_TTL_MS).toUTCString();
    this.browser.eval(
      `document.cookie="${SII_LOCEXP_COOKIE}=${expira};path=/;domain=.sii.cl;secure"`
    );
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
