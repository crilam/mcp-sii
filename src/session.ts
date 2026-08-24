import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'crypto';
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
// Página privada del portal que se usa como PUERTA de entrada al login por
// clave: navegar acá hace que el SII redirija al formulario (que abierto de
// frente no rinde) y deja la referencia de vuelta. Ver loginConClave.
const SII_PORTAL_PRIVADO = 'https://misiir.sii.cl/cgi_misii/siihome.cgi';
const SII_CERT_CGI = 'https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi';
const SII_LOGOUT_URL = 'https://zeusr.sii.cl/cgi_AUT2000/autTermino.cgi';
const SEL_EMPRESA_MARKERS = ['SELECCIÓN DE EMPRESA', '- option "'];

// Cookie de expiración que el CGI del SII escribe por JavaScript, con 2 horas
// de vigencia (el mismo valor que usa su propio script de autenticación).
const SII_LOCEXP_COOKIE = 'NETSCAPE_LIVEWIRE.locexp';
const LOCEXP_TTL_MS = 7_200_000;

// Subconjunto de SII_SESSION_COOKIES que PRUEBA que hay sesión: son las que usa
// el resto del flujo (el cookie jar de curl y `conversationId`). Alcanza con
// cualquiera de las dos; exigir las 13 de la lista completa ataría el chequeo de
// login a que el SII no deje de emitir ninguna.
const COOKIES_QUE_PRUEBAN_SESION = ['TOKEN', 'CSESSIONID'];

// Cookies del SII que NO son de sesión sino de la infraestructura que hay
// delante: el WAF F5 (`TS…`) y la cola de espera de Queue-it. Se preservan al
// limpiar antes de un login, porque tirarlas manda el intento de vuelta a la
// cola. Verificado en vivo: son exactamente las dos que sobreviven al borrado.
// Las del WAF van ancladas a las formas que emite F5: `TS<hex>` (la observada es
// `TS0161cd2b`), la misma con sufijo numérico (`TS01a1b2c3_28`) y las `TSPD*`.
// Ancladas y no por prefijo laxo: con `/^TS[0-9a-f]/`, nombres como `TSESSION`,
// `TSEC` o `TSAuth` —la `e` es hex— contarían como infraestructura y NO se
// borrarían, que es justo el residuo de sesión que este arreglo evita. Pero
// tampoco de más: una forma real del WAF que quede afuera se borra en cada
// login y devuelve el intento a la cola o al challenge, en silencio.
const COOKIES_DE_INFRAESTRUCTURA = [
  /^TS[0-9a-f]{6,}(_\d+)?$/i,
  /^TSPD/i,
  /^QueueITAccepted/i,
];

function esCookieDeInfraestructura(nombre: string): boolean {
  return COOKIES_DE_INFRAESTRUCTURA.some(patron => patron.test(nombre));
}

// Nombres de cookies de sesión que el SII establece tras autenticación. Las que
// prueban la sesión entran por spread, no repetidas a mano: así el "subconjunto
// de" del comentario de arriba es cierto por construcción y no puede
// desincronizarse si alguna de las dos listas cambia.
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
  ...COOKIES_QUE_PRUEBAN_SESION,
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
  // Identifica a ESTA sesión entre las varias que puede haber del mismo RUT (una
  // cacheada más una por request pass-through). Se usa para que sus archivos
  // temporales no se pisen; ver el getter `cookieJar`.
  private readonly idInstancia = randomUUID();

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
  // Un jar por INSTANCIA de sesión, no por RUT.
  //
  // Por RUT era un estado compartido con el mismo problema que tenía el contexto
  // del navegador: `ejecutarPassThrough` crea a propósito una sesión que no se
  // registra en `instancias`, así que puede coexistir con la cacheada del mismo
  // RUT. Con el jar compartido, la secuencia era: la cacheada autentica y escribe
  // el jar; llega un pass-through del mismo RUT, lo reescribe y al cerrar lo
  // BORRA; la cacheada sigue creyéndose autenticada, `rutaCookieJar()` devuelve
  // la ruta, y curl sale sin cookies — reportado después como sesión caducada.
  //
  // El sufijo hace únicos los archivos de cada instancia, así que cerrar una no
  // le saca el jar a otra.
  private get cookieJar(): string {
    return rutaTemporalSii('cookies', `${this.config.rut}-${this.idInstancia}`);
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
      await this.loginConClave();
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

  // Cierra el contexto del navegador de ESTA sesión. Es distinto de `logout()`:
  // logout cierra la sesión del lado del SII, esto libera el proceso y el perfil
  // en disco del lado nuestro. Lo llama el registro al desalojar una sesión —
  // sin esto, un servidor de larga vida acumula un contexto por cada RUT y por
  // cada request pass-through, sin techo.
  cerrarContexto(): void {
    // Cierra Y borra el perfil: cada sesión usa un contexto propio, así que
    // dejar el perfil en disco cambiaría una fuga de procesos por una de disco.
    this.browser.cerrarYBorrarPerfil();
    // Y el cookie jar, que son credenciales de sesión vivas en un directorio
    // compartido. Importa más desde que el login por clave también lo escribe:
    // `validar-clave` arma un jar en CADA validación, así que sin esto cada
    // request de un tenant deja uno atrás.
    try {
      fs.rmSync(this.cookieJar, { force: true });
    } catch {
      // Es limpieza: no puede tumbar el cierre de la sesión.
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
    // Las DOS estrategias pueden producir el cookie jar, así que ya no hay nada
    // que rechazar acá. Se conserva el método —y lo siguen llamando los scrapers
    // antes de autenticar— porque la pregunta que hace sigue siendo la correcta:
    // "¿esta sesión puede darme el jar?". Si mañana aparece una estrategia que
    // no pueda, este es el lugar donde se rechaza, y hacerlo ANTES de
    // `authenticateOnly()` evita abrir en el SII una sesión que después no se va
    // a poder usar y que igual cuenta para el límite de sesiones simultáneas.
    //
    // Antes exigía certificado, con este razonamiento: "sólo loginWithCert
    // escribe el jar (curl -c); con clave la autenticación corre en el navegador
    // y el archivo nunca existe". La primera mitad era cierta, la conclusión no:
    // el navegador TIENE las cookies, sólo que nadie las estaba escribiendo.
    // Verificado contra el portal exportándolas a un jar y consultando los CGI
    // de BHE, que respondieron con datos reales. Eso lo hace ahora
    // `loginConClave` al terminar (ver `escribirCookieJar`).
    //
    // El riesgo que ese guard también cubría —que quedara en $TMPDIR el jar de
    // una corrida vieja y curl mandara cookies de otra sesión, disparando el
    // bloqueo 01.01.190.500.720.27— sigue cubierto, pero por otro lado: el jar
    // se reescribe completo en cada login, y su ruta es por RUT.
  }

  // Lo que SÍ exige certificado digital: firmar. El SII no acepta una clave
  // tributaria para emitir un DTE, porque la firma electrónica avanzada sale del
  // certificado. Se separa del jar a propósito — son dos capacidades distintas y
  // confundirlas fue lo que dejó las consultas bloqueadas para clave sin motivo.
  assertPuedeFirmar(): void {
    if (this.config.strategy !== AuthStrategy.Certificate) {
      throw new RequiereCertificado(
        'Firmar documentos tributarios requiere certificado digital: la clave ' +
        'tributaria autentica, pero no firma. Configurá SII_CERT_PATH y ' +
        'SII_CERT_PASSWORD.'
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
  // Login con RUT + clave tributaria. Dos detalles del SII que NO son
  // opcionales, ambos descubiertos a fuerza de spikes contra el servicio real
  // (versiones anteriores fallaban justamente por saltearlos):
  //
  // 1. AL LOGIN SE LLEGA POR REDIRECT. Abrir SII_LOGIN_URL de frente devuelve
  //    una página en blanco (about:blank): el form no rinde nunca. Hay que
  //    navegar a una página PROTEGIDA (SII_PORTAL_PRIVADO) y dejar que el SII
  //    redirija al formulario; recién ahí existe `myform`. Ese redirect
  //    también deja en la URL la `referencia` de vuelta, que es lo que hace
  //    que el CGI devuelva al portal tras autenticar.
  //
  // 2. EL FORM SE ENVÍA CON requestSubmit(), NO CON UN CLICK. El form declara
  //    `onsubmit="return ejecuta_opcion()"` (que valida y llama form.submit()).
  //    Un click sintético en el botón "Ingresar" no dispara ese handler, así
  //    que NO SE ENVÍA NADA: la URL no cambia, no aparecen cookies de sesión,
  //    y el login "parece" haber ocurrido. De ahí venían los falsos OK de
  //    validarClave.
  //
  // Los campos se llenan por JS porque el form tiene hidden (`rut` sin dígito
  // verificador, `dv` aparte) que el usuario nunca tipea: los completa el
  // propio JS del SII al validar, y acá se replica.
  private async loginConClave(): Promise<void> {
    // Se limpia el contexto ANTES de intentar el login, y no es higiene
    // opcional: el éxito se decide por la presencia de las cookies de sesión
    // del SII, y el contexto de agent-browser PERSISTE entre invocaciones
    // (`new Browser(rut)` usa `--session <rut>`, ver restServerIndex.ts).
    // `logout()` sólo navega a la URL de término y su error se descarta a
    // propósito en validar-clave, así que un TOKEN/CSESSIONID de un login
    // anterior puede seguir ahí. Sin este borrado, una clave INCORRECTA vería
    // esa cookie vieja en el primer poll y se reportaría como válida — el mismo
    // falso positivo que este chequeo vino a cerrar, entrando por otra puerta.
    //
    // Se borra por ALLOWLIST, no por lista de nombres conocidos: se van todas
    // las cookies de dominio SII salvo las de infraestructura (WAF y cola de
    // espera). Con una denylist por nombre, una cookie de sesión que el SII
    // renombre o agregue quedaría sin borrar y volvería a habilitar el falso
    // positivo; con allowlist, lo peor que pasa si el SII agrega algo nuevo es
    // volver a la cola de espera. El riesgo queda del lado seguro.
    //
    // Y se borran con el dominio y el path que reporta el CLI, no con `.sii.cl`
    // fijo: una cookie host-only de `zeusr.sii.cl` no se borra apuntándole a
    // `.sii.cl`, pero sí la vería el chequeo de sesión — justo la asimetría que
    // reabría el agujero.
    try {
      const aBorrar = this.browser
        .cookiesDelSiiConUbicacion()
        .filter(c => !esCookieDeInfraestructura(c.name));
      // Los fallos individuales no cortan: lo que decide es la verificación de
      // abajo. Si alguna cookie que importa quedó viva, ahí se detecta; y si las
      // que fallaron eran irrelevantes, abortar habría sido un falso bloqueo.
      const fallidas = this.browser.borrarCookies(aBorrar);
      if (fallidas > 0) {
        console.error(`Login SII: ${fallidas} de ${aBorrar.length} cookies no se pudieron borrar.`);
      }

      // Se VERIFICA el borrado en vez de confiar en él. Expirar una cookie
      // depende de acertarle a sus atributos (dominio host-only, path, Secure):
      // si el `set` no matchea, crea otra entrada y la original sobrevive. Y una
      // cookie de sesión sobreviviente es exactamente lo que hace que una clave
      // incorrecta se reporte como válida, así que acá no alcanza con intentar.
      //
      // Se verifica SÓLO lo que el chequeo de éxito mira. Exigir que no
      // sobreviva ninguna cookie no-infraestructura era demasiado: el portal
      // tiene JS de analítica (AMCV_*, de Adobe) que se vuelve a escribir sola
      // apenas la página corre, y eso abortaba todos los logins — verificado en
      // vivo. Esas cookies no prueban ninguna sesión, así que su presencia es
      // irrelevante para lo que acá se está protegiendo.
      const sobrevivientes = this.sesionResidual();
      if (sobrevivientes.length > 0) {
        // Último recurso antes de rendirse: vaciar el jar completo. Cuesta el
        // token del WAF y el de la cola, o sea que este intento probablemente se
        // re-encole — pero la alternativa es peor de manera permanente: el
        // contexto es persistente por RUT (`--session <rut>`), así que una cookie
        // de sesión que el borrado selectivo no logre sacar dejaría a ese RUT sin
        // poder autenticar NUNCA MÁS, ni con la clave correcta. Re-encolarse es
        // caro una vez; un tenant bloqueado para siempre no tiene salida.
        console.error(
          `Login SII: el borrado selectivo dejó ${sobrevivientes.join(', ')}; se vacía el jar completo.`
        );
        this.browser.vaciarCookies();

        const tercos = this.sesionResidual();
        if (tercos.length > 0) {
          throw new Error(
            `quedaron cookies de la sesión anterior sin borrar incluso tras vaciar el jar: ${tercos.join(', ')}`
          );
        }
      }
    } catch (e) {
      // Sin poder limpiar no se puede confiar en las cookies que aparezcan
      // después: una de un login anterior daría por válida una clave que no lo
      // es. Se corta acá, y con un mensaje propio — si dijera lo mismo que el
      // fallo del chequeo posterior, en el log serían indistinguibles.
      console.error(
        `Login SII: no se pudo limpiar la sesión previa. detalle=${e instanceof Error ? e.message : e}`
      );
      throw new Error(
        'No se pudo limpiar la sesión anterior del navegador, así que no se ' +
        'puede verificar de forma confiable si la clave es correcta. Reintentá.'
      );
    }

    this.browser.open(SII_PORTAL_PRIVADO);
    await this.esperarFormularioDeLogin();

    const { rut, dv } = partirRut(this.config.rut, 'SII_RUT');
    const clave = this.config.clave!;
    // evalPrivado, NO eval: este JS lleva la clave tributaria del tenant. Con
    // `eval` (argv) quedaría visible en `ps`/`/proc/<pid>/cmdline` del
    // contenedor mientras agent-browser corre el comando.
    this.browser.evalPrivado(
      `(function(){` +
      `document.getElementById('rutcntr').value=${JSON.stringify(this.config.rut)};` +
      `document.getElementById('rut').value=${JSON.stringify(rut)};` +
      `document.getElementById('dv').value=${JSON.stringify(dv)};` +
      `document.getElementById('clave').value=${JSON.stringify(clave)};` +
      `})()`
    );
    this.browser.eval("document.getElementById('myform').requestSubmit()");

    await this.assertLoginPorClaveExitoso();

    // Se exporta la sesión del navegador al cookie jar que consume curl. Sin
    // esto, todas las consultas por HTTP (BHE, RCV, DTE, renta, mipyme) quedaban
    // fuera del alcance de la clave tributaria: el navegador tenía las cookies y
    // nadie las escribía. Va DESPUÉS de verificar el login, porque exportar el
    // jar de un login rechazado escribiría un archivo con las cookies del WAF y
    // nada más, y el fallo aparecería después como "la sesión expiró".
    const escritas = this.browser.escribirCookieJar(this.cookieJar);
    if (escritas === 0) {
      // El login se verificó exitoso, así que si acá no hay cookies es que algo
      // se rompió entre medio. Fallar es mejor que dejar un jar vacío: con el
      // archivo presente pero sin cookies, curl sale sin autenticación y el
      // error termina reportado como sesión caducada, apuntando al lugar
      // equivocado (es exactamente el modo de falla que el guard viejo temía).
      throw new Error(
        'El login por clave fue exitoso pero no se pudo exportar ninguna cookie ' +
        'de sesión al archivo que usan las consultas por HTTP. Reintentá.'
      );
    }
  }

  // El form sólo existe si el SII redirigió: si tras la espera no aparece,
  // es un problema de acceso al portal (WAF, sala de espera, mantención), no
  // una credencial inválida — se distingue en el mensaje para no reportarle a
  // un tenant "clave incorrecta" cuando el SII no nos dejó ni intentar.
  //
  // Sleep NO bloqueante (setTimeout, no execSync): este método corre dentro
  // del proceso REST, que atiende a varios tenants. Un sleep síncrono de hasta
  // 20s congelaría TODO el event loop y dejaría de responder a los demás
  // requests mientras espera. Ya se corrigió una vez este mismo anti-patrón
  // en el polling hermano (ver assertLoginPorClaveExitoso).
  private async esperarFormularioDeLogin(maxMs = 20_000, step = 1_000): Promise<void> {
    for (let esperado = 0; esperado < maxMs; esperado += step) {
      try {
        // Envuelto en try/catch: si el poll cae justo mientras la página
        // navega (contexto de ejecución destruido a mitad de un redirect), no
        // es que el form no vaya a aparecer — hay que tratarlo como "todavía
        // no", no como un error irrecuperable que corte el reintento.
        if (this.browser.eval("document.getElementById('myform') ? 'SI' : 'NO'").includes('SI')) return;
      } catch { /* la página está navegando; se reintenta en el próximo poll */ }
      await new Promise(resolve => setTimeout(resolve, step));
    }
    throw new Error(
      'El SII no mostró el formulario de autenticación (no se pudo llegar al login). Reintentá en unos minutos.'
    );
  }

  // El éxito se decide por la EVIDENCIA de que hay sesión —las cookies que el
  // SII sólo emite cuando autenticó— y no por la URL.
  //
  // La espera es generosa a propósito: un falso "clave incorrecta" por latencia
  // del SII es peor que tardar en detectar un rechazo genuino, porque al
  // consumidor le llega como CREDENCIALES_INVALIDAS y se lo muestra al usuario
  // final.
  //
  // Basarlo en la URL fue un falso positivo grave, verificado contra el portal:
  // con una clave incorrecta el SII postea a `CAutInicio.cgi` y renderiza ahí
  // mismo "La Clave Tributaria ingresada no es correcta" (código de mensaje
  // 01.01.217.500.720.20). Esa URL no es `IngresoRutClave` y sí es `sii.cl`, o
  // sea que cumplía las dos condiciones del chequeo viejo: `validar-clave`
  // devolvía ok:true para CUALQUIER clave, y el gate que Tributy usa para no
  // guardar credenciales inválidas no protegía nada.
  //
  // Las cookies no admiten esa ambigüedad: el login rechazado deja sólo las del
  // WAF y la cola (TS01…, QueueITAccepted), mientras el exitoso deja TOKEN,
  // CSESSIONID y las NETSCAPE_LIVEWIRE.* (17 en la corrida verificada).
  //
  // Nota: al no mirar la URL, un login que autenticó pero quedó parado en un
  // interstitial del portal (aviso, cambio de clave obligatorio) cuenta como
  // éxito. Para `validar-clave` es lo correcto —la credencial ES válida—, y en
  // el `login()` completo lo atrapa después la lectura del combo de empresas,
  // que falla explícitamente si la página no rinde.
  private async assertLoginPorClaveExitoso(maxMs = 15_000, stepInicial = 1_000): Promise<void> {
    let falloDeLectura: string | undefined;
    // Backoff con techo de 2s: 8 vueltas para cubrir los 15s, en vez de 15.
    //
    // Cuidado con la contabilidad: cada vuelta spawnea DOS procesos de
    // agent-browser (el `cookies get` del chequeo de sesión y el `eval` que lee
    // el motivo de rechazo), así que agotar el tiempo cuesta ~16 procesos —
    // ninguna mejora contra los 15 del criterio viejo. El backoff no está acá
    // por ahorro: está para no repreguntar 15 veces cuando el portal claramente
    // se está tomando su tiempo. Lo que sí ahorra de verdad es el corte
    // temprano por CLAVE_INCORRECTA de más abajo, medido en 3,7s contra 15.
    //
    // El techo en 2s, y no un backoff libre, es lo que evita que un login que
    // autentica a los 3,1s se detecte recién a los 7: `validar-clave` es
    // síncrono para Tributy.
    const stepMaximo = 2_000;
    for (
      let esperado = 0, step = stepInicial;
      esperado < maxMs;
      esperado += step, step = Math.min(step * 2, stepMaximo)
    ) {
      await new Promise(resolve => setTimeout(resolve, Math.min(step, maxMs - esperado)));
      try {
        if (this.tieneCookiesDeSesion()) return;
        falloDeLectura = undefined;
      } catch (e) {
        // No se pudo leer el estado de las cookies. Se sigue intentando (puede
        // ser transitorio), pero se recuerda: si el login termina fallando por
        // esto, el motivo real es "no se pudo verificar", no "no hay sesión".
        falloDeLectura = e instanceof Error ? e.message : String(e);
      }

      // El rechazo por clave incorrecta se busca DENTRO del loop, no al final.
      // Dos razones: es definitivo, así que esperar los 15s completos regala
      // tiempo en un endpoint que Tributy llama sincrónicamente; y el mensaje
      // vive en la página, así que si el portal navega mientras esperamos (un
      // interstitial, un redirect lento) el texto desaparece, el motivo saldría
      // `undefined` y una clave que nunca va a servir se reportaría como fallo
      // transitorio para que el tenant la reintente.
      if (this.leerMotivoDeRechazo() === 'CLAVE_INCORRECTA') {
        this.logearRechazo('CLAVE_INCORRECTA');
        // Este texto es el que clasificarErrorCredenciales mapea a
        // CREDENCIALES_INVALIDAS; no cambiarlo sin actualizar esa función.
        throw new Error('El SII rechazó la autenticación: RUT o clave incorrectos.');
      }
    }

    if (falloDeLectura) {
      console.error(`Login SII: no se pudo leer el estado de las cookies. detalle=${falloDeLectura}`);
      throw new Error(
        'No se pudo verificar si el SII estableció la sesión (falló la lectura de ' +
        'cookies del navegador), así que no se da el login por bueno. Reintentá.'
      );
    }

    // Se agotó el tiempo sin sesión y sin que la página dijera nunca que la
    // clave era incorrecta (eso ya habría salido dentro del loop).
    this.logearRechazo(undefined);
    throw new Error(
      'El SII no estableció una sesión y no informó que la clave sea incorrecta. ' +
      'Puede ser una caída del portal, la cola de espera o un bloqueo temporal; reintentá.'
    );
  }

  // Las cookies que todavía probarían una sesión. Es exactamente el conjunto que
  // mira `tieneCookiesDeSesion`: si acá queda alguna después de limpiar, el
  // chequeo de éxito la vería y daría por válida cualquier clave.
  private sesionResidual(): string[] {
    return this.browser
      .cookiesDelSiiConUbicacion()
      .filter(c => c.tieneValor && COOKIES_QUE_PRUEBAN_SESION.includes(c.name))
      .map(c => c.name);
  }

  private logearRechazo(motivo: string | undefined): void {
    // La URL es sólo para el log, así que su lectura no puede tumbar la
    // clasificación: si `getUrl` falla justo acá, el error que se propagaría es
    // el del CLI, y `validar-clave` devolvería ERROR en vez de
    // CREDENCIALES_INVALIDAS — o sea el tenant guardaría una clave inválida por
    // un fallo de logging. Mismo blindaje que ya tiene leerMotivoDeRechazo.
    let urlParaLog = '(no se pudo leer)';
    try {
      urlParaLog = this.sanearUrlParaLog(this.leerUrlActual());
    } catch { /* el log pierde la URL; la clasificación sigue en pie */ }
    console.error(
      `Login SII: no se establecieron cookies de sesión. url=${urlParaLog}` +
      `${motivo ? ` motivo=${motivo}` : ''}`
    );
  }

  // Lanza si no se puede leer el estado: quien llama distingue "no hay sesión"
  // de "no se pudo saber", que son cosas distintas para el tenant.
  private tieneCookiesDeSesion(): boolean {
    // Se exige que la cookie TENGA VALOR, no sólo que el nombre esté. El borrado
    // funciona expirando con valor vacío, y si el CLI no llega a removerla
    // —pasa cuando los atributos no matchean exacto: host-only contra `.sii.cl`,
    // Secure, HttpOnly— el nombre sobrevive con valor vacío. Mirando sólo el
    // nombre, esa cookia muerta daría por válida cualquier clave: el mismo falso
    // positivo por una tercera puerta. Así el chequeo no depende de que el
    // borrado haya sido perfecto.
    const conValor = new Set(
      this.browser.cookiesDelSiiConUbicacion().filter(c => c.tieneValor).map(c => c.name)
    );
    return COOKIES_QUE_PRUEBAN_SESION.some(nombre => conValor.has(nombre));
  }

  // Devuelve un motivo normalizado o undefined si no se reconoce. Sólo se
  // afirma lo que el portal dice con estas palabras: inventar una causa haría
  // que un fallo transitorio se reporte como credencial inválida, y el tenant
  // borraría una clave que en realidad servía.
  private leerMotivoDeRechazo(): 'CLAVE_INCORRECTA' | undefined {
    try {
      // Se lee la página completa, no los primeros 2000 caracteres: el portal
      // imprime el aviso y su código DEBAJO del header, el menú y la navegación,
      // y la página de CAutInicio.cgi pesa ~17 KB. Con el corte corto, el bloque
      // podía quedar afuera, ninguna de las dos señales matcheaba, el fallo salía
      // como ERROR y el tenant guardaba una clave inválida. Es una lectura local
      // del DOM: no cuesta red.
      const texto = this.browser.eval('document.body ? document.body.innerText : ""');
      // Dos señales, no una: el texto y el código de mensaje que el propio
      // portal imprime debajo ("El código de este mensaje es …"). Si el SII
      // cambia el copy, el código sigue identificando el caso; si mostrara el
      // código sin texto, tampoco se perdería. El tercer grupo del código varía
      // entre respuestas (se vieron 217 y 225), así que no se fija.
      return /Clave Tributaria ingresada no es correcta/i.test(texto) ||
        /01\.01\.\d+\.500\.720\.20\b/.test(texto)
        ? 'CLAVE_INCORRECTA'
        : undefined;
    } catch {
      return undefined;
    }
  }

  // Sólo origin + pathname: el query string puede traer el RUT, un token de
  // sesión u otros identificadores que el SII agregue tras el login.
  private sanearUrlParaLog(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return '(url no parseable)';
    }
  }

  private leerUrlActual(): string {
    return this.browser.getUrl();
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
