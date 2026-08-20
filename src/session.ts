import { AsyncLocalStorage } from 'node:async_hooks';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { Browser } from './browser';
import { AuthStrategy, SiiConfig } from './env';
import { partirRut } from './rut';
import { rutaTemporalSii } from './rutaTemporalSii';

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

// Ruta del cookie jar en formato Netscape que curl genera y que el cliente HTTP
// puede consumir con -b para reusar la sesión sin autenticar por su cuenta.

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

// La estrategia configurada no puede producir el cookie jar que necesita curl.
// Es una condición de configuración, no un fallo de sesión: no se arregla
// reautenticando ni reintentando, y por eso tiene tipo propio (ver
// BheScraper.conSesionFresca, que la deja pasar sin reintentar).
export class RequiereCertificado extends Error {}

export class SessionManager {
  private session: SiiSession | null = null;
  // Cola de exclusión mutua para las operaciones que dependen de la empresa
  // seleccionada (ver conEmpresaExclusiva). Es una promesa encadenada: cada
  // operación espera a la anterior antes de empezar. No hace falta más que
  // esto y no se agregan dependencias.
  private cola: Promise<void> = Promise.resolve();
  // Marca de reentrancia: si una operación ya serializada llama a otra (por
  // ejemplo el reintento de withReauth, o un scraper que compone dos pasos),
  // la interna NO debe volver a encolarse — esperaría a un candado que sólo
  // ella misma podría liberar, o sea deadlock.
  //
  // Tiene que ser AsyncLocalStorage y NO un booleano de instancia. Node es
  // monohilo pero asíncrono: mientras la sección crítica hace `await` sobre el
  // navegador, el event loop sigue corriendo y puede entrar una petición nueva
  // y ajena. Un flag compartido estaría en true en ese momento, la petición
  // nueva lo leería como "soy reentrante" y saltearía la cola, corriendo en
  // paralelo con la operación en curso — justo la fuga entre empresas que el
  // candado existe para impedir (era un P1 real, no una hipótesis).
  // AsyncLocalStorage acota la marca a la cadena de llamadas asíncrona: sólo
  // el código que desciende de `fn()` ve el contexto; una petición que llega
  // de afuera no lo ve y se encola como corresponde.
  private contextoSeccionCritica = new AsyncLocalStorage<true>();
  // Instante en que caduca la autenticación, o null si no hay ninguna vigente.
  // Guardar un booleano no alcanza: el servidor MCP vive mucho más que la
  // sesión del SII, y una marca que no caduca hace que las consultas salten el
  // login, vayan a una página protegida y fallen igual en cada reintento.
  private autenticadoHasta: number | null = null;

  constructor(
    private config: SiiConfig,
    private browser: Browser
  ) {}

  // Expone el Browser de esta sesión para scrapers que lo necesitan crudo
  // (BienesRaicesScraper lee el DOM directo, a diferencia del resto que habla
  // HTTP vía SiiHttpClient). El mismo Browser que ya autenticó esta sesión —
  // no uno nuevo — porque el estado autenticado vive en el contexto de
  // agent-browser que ese Browser referencia (--session <rut>).
  obtenerBrowser(): Browser {
    return this.browser;
  }

  // Cookie jar propio de esta credencial. Antes era una constante global, que
  // servía para un proceso de una sola credencial pero colisiona apenas hay
  // varias: dos sesiones escribiendo el mismo archivo se pisan las cookies y las
  // consultas salen con la sesión equivocada, sin error. Con el RUT en el nombre
  // cada credencial tiene el suyo. Ver rutaTemporalSii.
  private get cookieJar(): string {
    return rutaTemporalSii('cookies', this.config.rut);
  }

  // Serializa una operación COMPLETA que depende de la empresa seleccionada:
  // selección más las lecturas posteriores. El candado tiene que abarcar todo
  // el ciclo, no sólo la selección: la sesión del SII tiene una única empresa
  // activa, así que si dos llamadas con `empresa_rut` distinto se intercalan
  // —A selecciona, B selecciona, A lee— la primera lee la página de la
  // segunda y devuelve datos de otro contribuyente presentados como correctos.
  // Eso es peor que un error: nadie se entera. Proteger sólo selectEmpresa()
  // no arreglaría nada, porque la lectura quedaría fuera de la sección.
  //
  // El `finally` libera el turno aunque `fn` lance: si un fallo dejara el
  // candado tomado, toda operación posterior quedaría colgada para siempre.
  async conEmpresaExclusiva<T>(fn: () => Promise<T>): Promise<T> {
    if (this.contextoSeccionCritica.getStore()) return fn();

    const anterior = this.cola;
    let liberar!: () => void;
    const turno = new Promise<void>(resolve => { liberar = resolve; });
    // La cola avanza con el turno pase lo que pase con la operación previa:
    // un rechazo no propagado dejaría el resto de la cola sin ejecutarse.
    this.cola = anterior.then(() => turno, () => turno);

    await anterior.catch(() => { /* el error es del llamador anterior */ });

    try {
      // `run` devuelve lo que devuelva el callback; el await queda afuera para
      // que el contexto siga vigente durante toda la promesa de `fn`.
      return await this.contextoSeccionCritica.run(true, fn);
    } finally {
      liberar();
    }
  }

  async login(empresaRut?: string): Promise<SiiSession> {
    await this.authenticate();
    const session = await this.selectEmpresa(empresaRut);
    this.session = session;
    return session;
  }

  // Lista las empresas que la persona puede operar sin exigir que una esté
  // seleccionada: es el paso previo a configurar SII_EMPRESA_RUT, así que no
  // puede depender de getSession() (que falla justamente cuando hay varias).
  async listEmpresasDisponibles(): Promise<Empresa[]> {
    await this.authenticate();
    const snapshot = this.abrirPaginaSeleccionEmpresa();
    return this.parseEmpresas(snapshot);
  }

  // Navega a la página de selección de empresa y espera a que rinda antes de
  // leer el combo. La usan tanto listEmpresasDisponibles() (listado previo a
  // configurar SII_EMPRESA_RUT) como selectEmpresa() (selección real): las
  // dos necesitan el mismo guard, porque justo después de navegar la página
  // puede no haber rendido todavía y un snapshot prematuro trae cero
  // empresas, que se confunde con "esta persona no opera ninguna".
  private abrirPaginaSeleccionEmpresa(): string {
    this.browser.open(SII_SEL_EMPRESA_URL);
    this.browser.waitForAny(SEL_EMPRESA_MARKERS, 20_000);
    const snapshot = this.browser.snapshot();

    if (!SEL_EMPRESA_MARKERS.some(m => snapshot.includes(m))) {
      throw new Error(
        'La página de selección de empresa no terminó de cargar. Reintentá en unos minutos.'
      );
    }

    return snapshot;
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
    if (this.autenticadoHasta !== null && Date.now() < this.autenticadoHasta) return;

    if (this.config.strategy === AuthStrategy.Certificate) {
      await this.loginWithCert();
    } else {
      this.browser.open(SII_LOGIN_URL);
      const loginSnapshot = this.browser.snapshot();
      await this.fillClaveForm(loginSnapshot);
    }

    // La sesión dura lo mismo que la cookie `locexp` que el propio SII emite.
    this.autenticadoHasta = Date.now() + LOCEXP_TTL_MS;
  }

  // Cierra la sesión en el SII. Sin esto las sesiones quedan abiertas del lado
  // del servicio hasta que expiran, y se acumulan hasta bloquear el acceso.
  async logout(): Promise<void> {
    if (this.autenticadoHasta === null) return;

    try {
      this.browser.open(SII_LOGOUT_URL);
    } finally {
      this.autenticadoHasta = null;
      this.session = null;
    }
  }

  // Orden de resolución de la empresa: el parámetro de la llamada gana siempre
  // (es la intención explícita de quien invoca la tool); si no vino, cae a
  // SII_EMPRESA_RUT; si tampoco hay, selectEmpresa() resuelve sola cuando la
  // persona opera una única empresa. Si ya hay sesión en otra empresa, se
  // cambia de empresa en la misma sesión: abrir una segunda sesión para la
  // misma persona dispara el bloqueo del SII (01.01.190.500.720.27).
  async getSession(empresaRut?: string): Promise<SiiSession> {
    if (!this.session) {
      return this.login(empresaRut);
    }
    if (empresaRut && empresaRut !== this.session.empresaRut) {
      return this.cambiarEmpresa(empresaRut);
    }
    return this.session;
  }

  // Cambia de empresa reutilizando la autenticación vigente: sólo renavega el
  // combo de selección de empresa, sin volver a pasar por authenticate().
  private async cambiarEmpresa(empresaRut: string): Promise<SiiSession> {
    const session = await this.selectEmpresa(empresaRut);
    this.session = session;
    return session;
  }

  // La sesión del SII expiró o fue rechazada: hay que reautenticar, así que el
  // flag de autenticación también se limpia.
  invalidate(): void {
    this.session = null;
    this.autenticadoHasta = null;
  }

  // El cliente HTTP necesita las cookies, pero no debe autenticar por su
  // cuenta: dos sesiones simultáneas contra el mismo RUT disparan el bloqueo
  // del SII. La sesión la administra sólo esta clase.
  async rutaCookieJar(): Promise<string> {
    this.assertPuedeEntregarCookieJar();
    await this.authenticate();
    return this.cookieJar;
  }

  // El `conversationId` que exigen las APIs modernas del portal (el sobre SDI)
  // es el valor de la cookie TOKEN. Vive acá, y no en el cliente HTTP, porque
  // el dueño del cookie jar es esta clase: si el transporte leyera el archivo
  // por su cuenta habría dos lugares que saben dónde está y con qué formato.
  //
  // Falla explícito cuando la cookie no está: mandar el sobre con un
  // conversationId vacío devuelve "Acceso no autorizado!", un mensaje que
  // manda a revisar permisos cuando el problema es que no hay sesión.
  conversationId(): string {
    const token = this.parseCookieFile(this.cookieJar)['TOKEN'];
    if (!token) {
      throw new Error(
        'No se encontró la cookie TOKEN de la sesión del SII, necesaria para consultar ' +
        'las APIs del portal. Autenticá con certificado digital (SII_CERT_PATH y ' +
        'SII_CERT_PASSWORD) antes de consultar.'
      );
    }
    return token;
  }

  // Se expone aparte de `rutaCookieJar` para que quien vaya a consultar por HTTP
  // pueda descartar el caso imposible ANTES de autenticar. Verificarlo recién en
  // `rutaCookieJar` llega tarde: para entonces el scraper ya llamó a
  // `authenticateOnly()` y abrió una sesión en el SII que nunca va a poder usar,
  // sumando al contador que dispara el bloqueo 01.01.190.500.720.27 — justo lo
  // que este guard existe para evitar. El llamador no necesita conocer las
  // estrategias de autenticación: sólo pregunta si esta sesión puede servirlo.
  assertPuedeEntregarCookieJar(): void {
    // Sólo `loginWithCert` escribe el cookie jar (curl -c). Con estrategia de
    // clave la autenticación pasa por el navegador y el archivo nunca existe,
    // así que devolver la ruta igual haría que curl salga sin cookies y el
    // fallo se reporte como "la sesión pudo expirar", que apunta al lugar
    // equivocado. Peor: si en esta máquina hubo antes una corrida con
    // certificado, el archivo quedó en $TMPDIR y curl -b mandaría cookies de
    // una sesión anterior, que es justo lo que dispara el bloqueo del SII
    // 01.01.190.500.720.27. Se falla antes de tocar la red.
    if (this.config.strategy !== AuthStrategy.Certificate) {
      throw new RequiereCertificado(
        'Las consultas por HTTP (boletas de honorarios) requieren autenticación con ' +
        'certificado digital: la autenticación con clave tributaria corre en el navegador ' +
        'y no produce el archivo de cookies que necesita curl. ' +
        'Configurá SII_CERT_PATH y SII_CERT_PASSWORD.'
      );
    }
  }

  // Los CGI de BHE y las APIs del portal esperan el RUT partido en cuerpo y
  // dígito verificador. SII_RUT viene como "11111111-1"; sin guión, el DV es el
  // último carácter. La partición vive en `src/rut.ts` porque la comparten esta
  // clase y el scraper del RCV (que parte el RUT de la empresa consultada): dos
  // copias divergieron una vez en si validaban o no el resultado.
  identidad(): { rut: string; dv: string } {
    return partirRut(this.config.rut, 'SII_RUT');
  }

  // La clave del certificado que el contribuyente tiene cargado en el SII, con
  // la que el portal mipyme firma los DTE del lado servidor. Se expone desde acá
  // —dueña de la configuración sensible— para que el scraper no lea el entorno
  // por su cuenta, y sobre todo para que la clave NO sea un parámetro de la
  // tool: así el modelo nunca la ve.
  claveCertificadoSii(): string | undefined {
    return this.config.claveCertificadoSii;
  }

  // Autentica con certificado digital vía curl (TLS mutual auth), luego inyecta
  // las cookies de sesión en agent-browser navegando a un dominio .sii.cl.
  private async loginWithCert(): Promise<void> {
    const { certPath, certPassword } = this.config;
    if (!certPath || !certPassword) {
      throw new Error('loginWithCert requiere SII_CERT_PATH y SII_CERT_PASSWORD');
    }

    // También por credencial: dos logins concurrentes de RUTs distintos escriben
    // sus PEM a la vez, y con rutas fijas se pisarían el material de clave.
    const certPem = rutaTemporalSii('cert', this.config.rut);
    const keyPem = rutaTemporalSii('key', this.config.rut);
    const cookiesFile = this.cookieJar;

    // La clave privada se extrae con -nodes, o sea sin cifrar, a un directorio
    // compartido. El `finally` no es decorativo: sin él, cualquier salida por
    // excepción —certificado vencido, caída de red— deja material de clave
    // reutilizable en disco, y justo en el camino de fallo.
    let cookieMap: Record<string, string>;
    try {
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
      cookieMap = this.parseCookieFile(cookiesFile);
    } finally {
      try { fs.unlinkSync(certPem); } catch { /* no se alcanzó a crear */ }
      try { fs.unlinkSync(keyPem); } catch { /* no se alcanzó a crear */ }
    }

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

  // El SII no manda ningún error con clave incorrecta acá (a diferencia del
  // CGI de certificado, ver assertAutenticacionExitosa): sólo re-renderiza la
  // MISMA página de login. Sin este chequeo, cualquier clave "pasaba" y
  // validarClave (src/rest/rutas/sesion.ts) reportaba {ok:true} con
  // credenciales inválidas.
  //
  // Se detecta por CONTENIDO (¿sigue el campo de clave en el snapshot?), no
  // por URL: una primera versión verificaba document.location.href, pero un
  // login con clave VÁLIDA confirmada por el usuario también quedó atrapado
  // — el SII no navega a otra URL en este flujo, re-renderiza sobre la misma.
  // El campo de clave desaparece del DOM cuando el login efectivamente
  // avanza, tanto si cae en selección de empresa como en cualquier otra
  // página post-login. La URL sigue chequeándose, pero sólo COMO CONFIRMACIÓN
  // final (no como condición de cambio): si el campo desaparece pero el
  // destino no es un dominio de sii.cl, no es un login exitoso — es una
  // página de error/mantención ajena, y sin este chequeo cualquier
  // interstitial sin form volvería a reportar {ok:true} con credenciales
  // inválidas (el mismo bug que cerró el PR #36, por otra vía).
  private async fillClaveForm(snapshot: string): Promise<void> {
    const rutRef = this.findRef(snapshot, /rut|run/i) ?? '@e1';
    const claveRef = this.findRef(snapshot, /clave|contraseña|password/i) ?? '@e2';
    const btnRef = this.findRef(snapshot, /ingresar|entrar|login/i) ?? '@e3';

    this.browser.fill(rutRef, this.config.rut);
    this.browser.fill(claveRef, this.config.clave!);
    this.browser.click(btnRef);

    // 15s es generoso a propósito: un falso "clave incorrecta" por latencia
    // real del SII es peor que tardar un poco más en detectar un rechazo
    // genuino — a Tributy le llega como CREDENCIALES_INVALIDAS y se lo
    // muestra tal cual al usuario final.
    const siguioEnFormularioDeLogin = await this.esperarSalirDelFormularioDeLogin();
    if (siguioEnFormularioDeLogin) {
      throw new Error('El SII rechazó la autenticación: RUT o clave incorrectos.');
    }
    const urlFinal = this.leerUrlActual();
    if (!/^https:\/\/([^/?]+\.)?sii\.cl(\/|\?|$)/.test(urlFinal)) {
      throw new Error('El SII rechazó la autenticación: destino inesperado tras el login.');
    }
  }

  // Polling corto: el click dispara el submit pero el re-render no es
  // instantáneo. Devuelve true si el campo de clave SIGUE en el snapshot al
  // agotarse el tiempo (rechazo o timeout) — false apenas desaparece (login
  // avanzó). Un snapshot vacío/basura del CLI cuenta como "sigue" (fail-safe:
  // nunca se interpreta la ausencia de datos como éxito). Sleep no
  // bloqueante: este método corre dentro del proceso REST — un sleep
  // síncrono (execSync) congelaría TODO el event loop, dejando de atender
  // otros requests mientras dura el polling.
  private async esperarSalirDelFormularioDeLogin(maxMs = 15_000, step = 1_000): Promise<boolean> {
    let elapsed = 0;
    while (elapsed < maxMs) {
      const s = this.browser.snapshot();
      if (!(!s || this.campoDeClavePresente(s))) return false;
      await new Promise(resolve => setTimeout(resolve, step));
      elapsed += step;
    }
    return true;
  }

  // A diferencia de findRef genérico (usado para UBICAR el campo antes de
  // llenarlo), acá exige que la línea sea un campo de INPUT (textbox o
  // password) — no cualquier elemento que mencione "clave". Sin esta
  // restricción, un link o botón post-login como "Cambiar clave" (existe en
  // el menú de MiSII) haría que el chequeo crea que el form de login sigue
  // presente, y reportaría el mismo falso CREDENCIALES_INVALIDAS que este
  // fix corrige, por otra vía.
  private campoDeClavePresente(snapshot: string): boolean {
    return snapshot.split('\n').some(
      line => /textbox|password/i.test(line) && /clave|contraseña|password/i.test(line)
    );
  }

  private leerUrlActual(): string {
    return this.browser.eval('document.location.href');
  }

  // empresaRutParam es la empresa pedida en la llamada (mayor prioridad).
  // Orden de resolución: parámetro > SII_EMPRESA_RUT > única empresa disponible.
  private async selectEmpresa(empresaRutParam?: string): Promise<SiiSession> {
    // abrirPaginaSeleccionEmpresa() espera los marcadores antes de leer el
    // snapshot: sin esa espera, un render lento deja empresas=[] y, con
    // rutPreferido seteado, esta función devolvería una sesión "seleccionada"
    // sin haber tocado el navegador — y quedaría cacheada como válida.
    const snapshot = this.abrirPaginaSeleccionEmpresa();
    const empresas = this.parseEmpresas(snapshot);
    const rutPreferido = empresaRutParam ?? this.config.empresaRut;

    if (empresas.length === 0) {
      if (rutPreferido) {
        return { empresaRut: rutPreferido, empresaNombre: rutPreferido };
      }
      throw new Error('No se encontraron empresas disponibles. Pasá empresa_rut en la llamada o configura SII_EMPRESA_RUT.');
    }

    if (empresas.length === 1) {
      const empresa = empresas[0];
      // Si pidieron una empresa explícita que no es la única disponible, hay
      // que fallar igual que la rama de varias empresas: seleccionar la que
      // hay sin más dejaría la sesión en una empresa distinta a la pedida,
      // devolviendo datos que parecen correctos pero son de otro contribuyente.
      if (rutPreferido && rutPreferido !== empresa.rut) {
        throw new Error(`Empresa ${rutPreferido} no encontrada. Disponibles: ${empresa.rut}`);
      }
      const selectRef = this.findRef(snapshot, /empresa/i) ?? '@e10';
      this.browser.select(selectRef, empresa.rut);
      return { empresaRut: empresa.rut, empresaNombre: empresa.nombre };
    }

    // Varias empresas: sin un RUT explícito (por parámetro o env var) no hay
    // forma de elegir por la persona, así que el error debe darle ambas
    // salidas y la lista completa para resolverlo sin leer código.
    if (!rutPreferido) {
      const lista = empresas.map(e => `${e.rut} — ${e.nombre}`).join(', ');
      throw new Error(
        `Esta persona opera ${empresas.length} empresas. Pasá empresa_rut en la llamada, ` +
        `o configura SII_EMPRESA_RUT, con uno de: ${lista}`
      );
    }

    const empresa = empresas.find(e => e.rut === rutPreferido);
    if (!empresa) {
      throw new Error(`Empresa ${rutPreferido} no encontrada. Disponibles: ${empresas.map(e => e.rut).join(', ')}`);
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
