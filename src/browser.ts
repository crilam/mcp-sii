import { execFileSync, execSync } from 'child_process';

// maxBuffer explícito: el default de Node (1 MB) lo revienta un snapshot
// grande del árbol de accesibilidad de una página con muchos elementos.
const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 };

// Error de una invocación de agent-browser SIN el comando ni sus argumentos en
// el mensaje (ver comentario de Browser.run). `salida` trae stderr/stdout del
// CLI, que sí es seguro: el CLI no repite los argumentos que recibió.
//
// NO se guarda el error original (`causa`/`cause`) como propiedad propia: aun
// siendo `readonly`, una prop propia es ENUMERABLE por defecto, y
// `console.error(err)` / `util.inspect(err)` imprimen las props propias
// incluido `causa.message`, que en execFileSync es "Command failed: " + el
// comando COMPLETO con argumentos — y ahí SÍ puede ir la clave tributaria (el
// login por clave la manda en el JS de `eval`). src/rest/auditoria.ts loguea
// el error completo con console.error, así que cualquier prop enumerable con
// el mensaje crudo puede terminar en CloudWatch. Sólo se conservan `code` y
// `signal`, que identifican timeouts/señales del proceso sin llevar datos.
//
// Y no alcanzaría con hacerla no enumerable: si se guardara bajo el nombre
// `cause`, `util.inspect`/`console.error` la imprimen igual (verificado en
// Node), porque el formateador de Error trata `cause` como caso especial en vez
// de recorrer sólo las props enumerables. La única defensa es no guardarla.
export class ErrorDeBrowser extends Error {
  readonly code?: string;
  readonly signal?: string;

  constructor(readonly subcomando: string, readonly salida: string, causa?: unknown) {
    super(`agent-browser falló al ejecutar '${subcomando}'${salida ? `: ${salida}` : ''}`);
    this.name = 'ErrorDeBrowser';
    this.code = (causa as any)?.code;
    this.signal = (causa as any)?.signal;
  }
}

// Una cookie identificada por dónde vive, que es lo que hace falta para
// borrarla. Sin el valor: es una credencial de sesión y no tiene por qué
// circular ni terminar en un log.
export interface CookieUbicada {
  name: string;
  domain: string;
  path: string;
  // Si la cookie tiene contenido. NO el contenido: alcanza para distinguir una
  // cookie viva de una que quedó con valor vacío, que es lo que pasa cuando el
  // borrado por expiración no la remueve del todo (los atributos no matchean
  // exacto: host-only contra `.sii.cl`, Secure, HttpOnly). Un nombre presente
  // con valor vacío no prueba ninguna sesión.
  tieneValor: boolean;
}

// `includes('sii.cl')` daría por buenos `notsii.cl` o `sii.cl.evil.com`: el
// dominio tiene que ser el del SII o un subdominio suyo.
function esDominioDelSii(dominio: string): boolean {
  const d = dominio.replace(/^\./, '').toLowerCase();
  return d === 'sii.cl' || d.endsWith('.sii.cl');
}

export class Browser {
  constructor(private sessionId?: string) {}

  // execFileSync, NO execSync: los args van directo al proceso (argv), sin
  // pasar por un shell. Con execSync + interpolación de string, una clave
  // tributaria con comillas/`$`/backtick/`\` rompía el comando (error de
  // sintaxis) o, peor, podía inyectar comandos arbitrarios en el contenedor —
  // la clave llega del body de /v1/sesion/validar-clave, que es input de un
  // tenant externo, no confiable.
  // El `message` del error de execFileSync arranca con "Command failed: " y
  // el comando COMPLETO, argumentos incluidos. Varios argumentos llevan datos
  // sensibles (la clave tributaria del tenant viaja en el JS de `eval` al
  // llenar el formulario de login), y ese `message` sí se loguea aguas arriba
  // (rest/rutas/comun.ts, restServer.ts) — o sea que sin esto una clave puede
  // terminar en CloudWatch. Se reemplaza el mensaje por uno que sólo nombra el
  // SUBCOMANDO (args[0]: open/eval/snapshot/...), nunca sus argumentos.
  private run(args: string[]): string {
    const prefijoSesion = this.sessionId ? ['--session', this.sessionId] : [];
    try {
      return execFileSync('agent-browser', [...prefijoSesion, ...args], EXEC_OPTS).toString().trim();
    } catch (e) {
      const subcomando = args[0] ?? '(sin comando)';
      const salida = [(e as any)?.stderr?.toString() ?? '', (e as any)?.stdout?.toString() ?? ''].join(' ').trim();
      throw new ErrorDeBrowser(subcomando, salida, e);
    }
  }

  // Ejecuta UN comando pasando sus argumentos por STDIN en vez de por argv,
  // usando el modo batch de agent-browser (`batch --json`, que acepta un
  // array JSON de arrays de argumentos). Es la variante que usa evalPrivado():
  // los argumentos de `run()` viajan en el argv del proceso agent-browser, así
  // que son visibles para cualquiera con acceso a `ps`/`/proc/<pid>/cmdline`
  // en el contenedor — y el `eval` que llena la clave del formulario de login
  // lleva la clave tributaria del tenant en ese argumento. Por stdin el JS
  // nunca aparece en argv.
  private runPorStdin(args: string[]): string {
    const prefijoSesion = this.sessionId ? ['--session', this.sessionId] : [];
    try {
      const salidaCruda = execFileSync(
        'agent-browser',
        [...prefijoSesion, 'batch', '--json'],
        { ...EXEC_OPTS, input: JSON.stringify([args]) }
      ).toString().trim();

      // batch --json responde un array con UN resultado por comando enviado;
      // acá siempre se manda uno solo. `success:false` es un rechazo del
      // propio comando (no una excepción del proceso), así que se traduce
      // igual a ErrorDeBrowser. `item.error` es un mensaje del CLI, no repite
      // los argumentos que mandamos, así que es seguro incluirlo en `salida`.
      const [item] = JSON.parse(salidaCruda);
      if (!item?.success) {
        throw new ErrorDeBrowser(args[0] ?? '(sin comando)', String(item?.error ?? ''));
      }
      const valor = item?.result?.result;
      return valor === undefined || valor === null ? '' : String(valor);
    } catch (e) {
      if (e instanceof ErrorDeBrowser) throw e;
      const subcomando = args[0] ?? '(sin comando)';
      const salida = [(e as any)?.stderr?.toString() ?? '', (e as any)?.stdout?.toString() ?? ''].join(' ').trim();
      throw new ErrorDeBrowser(subcomando, salida, e);
    }
  }

  open(url: string): void {
    this.run(['open', url]);
  }

  // Navega a una URL que puede mostrar un JS confirm dialog durante la carga.
  // Captura el error provocado por el dialog y lo deja pendiente para que el
  // llamador resuelva con dialogAccept(). La pista del dialog/timeout viene en
  // la salida del CLI (ErrorDeBrowser.salida / message) o, cuando el CLI no
  // llegó a imprimir nada (timeout puro, `salida` vacía), en `code`/`signal`
  // propagados desde el error original de execFileSync — ahí es donde
  // "spawnSync agent-browser ETIMEDOUT" queda registrado, y ese texto ya NO
  // está en el message saneado de ErrorDeBrowser.
  openWithPendingDialog(url: string): void {
    try {
      this.run(['open', url]);
    } catch (err: unknown) {
      const texto = err instanceof ErrorDeBrowser
        ? `${err.message} ${err.salida}`
        : (err instanceof Error ? err.message : String(err));
      const esTimeoutPorCodigo = err instanceof ErrorDeBrowser && err.code === 'ETIMEDOUT';
      if (!esTimeoutPorCodigo && !/timed.?out|ETIMEDOUT|dialog/i.test(texto)) throw err;
    }
  }

  snapshot(): string {
    return this.run(['snapshot']);
  }

  click(ref: string): void {
    this.run(['click', ref]);
  }

  fill(ref: string, text: string): void {
    this.run(['fill', ref, text]);
  }

  type(ref: string, text: string): void {
    this.run(['type', ref, text]);
  }

  getText(ref: string): string {
    return this.run(['get', 'text', ref]);
  }

  // Comando dedicado del CLI, no `eval('document.location.href')`: evaluar
  // JS en la página justo después de una navegación puede pegarle a un
  // contexto de ejecución que ya no existe (la página cambió de nuevo) y
  // devolver un mensaje de error del propio motor en vez de la URL —
  // confirmado en prod, ver PR de diagnóstico del falso negativo de clave.
  getUrl(): string {
    return this.run(['get', 'url']);
  }

  select(ref: string, value: string): void {
    this.run(['select', ref, value]);
  }

  eval(js: string): string {
    return this.run(['eval', js]);
  }

  // Variante de `eval` para JS que lleva datos sensibles (la clave tributaria
  // al llenar el formulario de login). Usa `runPorStdin`, o sea que el JS
  // viaja por stdin del proceso agent-browser y no queda en su argv, visible
  // para `ps`/`/proc/<pid>/cmdline` en el contenedor. Los demás `eval` (chequeo
  // de myform, requestSubmit, lectura de document.cookie/location.href) no
  // llevan secretos y pueden seguir usando `eval()` por argv.
  evalPrivado(js: string): string {
    return this.runPorStdin(['eval', js]);
  }

  // Va por el comando dedicado del CLI y no por `eval('document.cookie')`: el
  // comando lee el jar del CONTEXTO, que es lo que hace falta —`document.cookie`
  // depende de la página cargada y no ve las cookies marcadas HttpOnly, así que
  // un chequeo de "¿hay sesión?" basado en eso sería frágil justo cuando importa.
  // (Medido contra el portal: hoy TOKEN y CSESSIONID vienen con httpOnly=false y
  // valor de 13 caracteres, pero el criterio no depende de que eso siga así.)
  //
  // Nunca devuelve los valores: son credenciales de sesión, y para saber si hay
  // sesión alcanza con el nombre y un booleano de "tiene contenido".
  // Se relanza SIN la salida del CLI. `run()` mete stderr+stdout en el mensaje y
  // en la prop `salida`, y acá eso es peligroso: si el comando falla con código
  // ≠ 0 pero alcanzó a imprimir JSON, ese JSON trae los VALORES de
  // TOKEN/CSESSIONID. Ese mensaje se loguea aguas arriba, así que sin este
  // filtro los tokens de sesión terminarían en CloudWatch.
  private leerCookiesCrudas(): string {
    try {
      return this.run(['cookies', 'get', '--json']);
    } catch (e) {
      // Se descarta la SALIDA del CLI (puede traer los valores de las cookies),
      // pero no todo: el código del fallo y la clase del error no llevan datos y
      // son lo único que le dice al operador si fue un timeout, un CLI ausente o
      // algo más. Con una cadena vacía, los tres casos se veían igual.
      const codigo = e instanceof ErrorDeBrowser && e.code ? e.code : 'sin código';
      const clase = e instanceof Error ? e.constructor.name : typeof e;
      throw new ErrorDeBrowser('cookies get', `salida omitida (${clase}, ${codigo})`);
    }
  }

  // Las cookies de dominio SII con el dominio y el path que reporta el CLI, que
  // es lo que hace falta para BORRAR una: una emitida host-only por
  // `zeusr.sii.cl`, o con un path específico, no se borra apuntándole a
  // `.sii.cl` con path `/`. Nunca devuelve los valores.
  cookiesDelSiiConUbicacion(): CookieUbicada[] {
    const salida = this.leerCookiesCrudas();
    let cookies: unknown;
    try {
      // Forma verificada contra el CLI: {"success":true,"data":{"cookies":[…]}}.
      cookies = JSON.parse(salida)?.data?.cookies;
    } catch {
      throw new ErrorDeBrowser('cookies get', 'respuesta no parseable del CLI');
    }
    // Un JSON válido con OTRA forma no es "no hay cookies": es que no se pudo
    // saber. Devolver [] acá sería el peor resultado posible — quien pregunta
    // usa esto para decidir si el login autenticó, así que un array vacío
    // silencioso haría fallar todo login con clave válida. Se lanza, igual que
    // si el JSON no parseara.
    if (!Array.isArray(cookies)) {
      throw new ErrorDeBrowser('cookies get', 'el CLI no devolvió data.cookies como arreglo');
    }
    return cookies
      .filter((c): c is { name?: string; domain?: string; path?: string; value?: string } =>
        esDominioDelSii(String((c as { domain?: string })?.domain ?? '')))
      .map(c => ({
        name: String(c?.name ?? ''),
        domain: String(c?.domain ?? ''),
        path: String(c?.path ?? '/') || '/',
        // El valor se convierte a booleano acá mismo y no sale de este método.
        tieneValor: String(c?.value ?? '') !== '',
      }))
      // Una cookie sin nombre no sirve para nada y en el camino de borrado
      // produciría `cookies set '' '' --domain …`, una llamada basura que puede
      // fallar y abortar el login entero.
      .filter(c => c.name !== '');
  }

  // Borra las cookies indicadas, y sólo esas, expirándolas en el pasado
  // (verificado contra el CLI: una cookie con `--expires 1` desaparece del
  // contexto). NO se usa `cookies clear`, que borraría todo el jar: ahí también
  // viven el token del WAF y el de la cola de espera del SII (`QueueITAccepted`),
  // y tirarlos manda cada login de vuelta a la cola, que bajo carga puede hacer
  // fallar un login con credenciales perfectamente válidas.
  // Devuelve cuántas no se pudieron borrar. Un `set` que falla NO aborta el
  // resto: si una cookie del jar tiene un nombre o dominio que el CLI rechaza,
  // cortar ahí dejaría sin borrar todas las siguientes —incluidas las que sí
  // importan— y haría fallar el login entero sin salida. Quien llama decide qué
  // hacer; la garantía real es re-leer y verificar, no que cada `set` funcione.
  borrarCookies(cookies: CookieUbicada[]): number {
    let fallidas = 0;
    for (const { name, domain, path } of cookies) {
      try {
        this.run(['cookies', 'set', name, '', '--domain', domain, '--path', path, '--expires', '1']);
      } catch {
        fallidas += 1;
      }
    }
    return fallidas;
  }

  press(key: string): void {
    this.run(['press', key]);
  }

  dialogAccept(): void {
    this.run(['dialog', 'accept']);
  }

  dialogDismiss(): void {
    this.run(['dialog', 'dismiss']);
  }

  waitForAny(texts: string[], maxMs = 10_000): void {
    const step = 2_000;
    let elapsed = 0;
    while (elapsed < maxMs) {
      const s = this.snapshot();
      if (texts.some(t => s.includes(t))) return;
      execSync(`sleep ${step / 1000}`);
      elapsed += step;
    }
  }

  // Espera a que aparezca un texto en el snapshot (polling, max 10s por defecto)
  waitFor(text: string, maxMs = 10_000): void {
    const step = 2_000;
    let elapsed = 0;
    while (elapsed < maxMs) {
      const s = this.snapshot();
      if (s.includes(text)) return;
      execSync(`sleep ${step / 1000}`);
      elapsed += step;
    }
  }

  close(): void {
    this.run(['close']);
  }
}
