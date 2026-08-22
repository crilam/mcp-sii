import { execFileSync, execSync } from 'child_process';

// maxBuffer explícito: el default de Node (1 MB) lo revienta un snapshot
// grande del árbol de accesibilidad de una página con muchos elementos.
const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 };

// Error de una invocación de agent-browser SIN el comando ni sus argumentos en
// el mensaje (ver comentario de Browser.run). `salida` trae stderr/stdout del
// CLI, que sí es seguro: el CLI no repite los argumentos que recibió. La causa
// original queda en `causa` para depurar en un breakpoint, nunca en el message.
export class ErrorDeBrowser extends Error {
  constructor(readonly subcomando: string, readonly salida: string, readonly causa?: unknown) {
    super(`agent-browser falló al ejecutar '${subcomando}'${salida ? `: ${salida}` : ''}`);
    this.name = 'ErrorDeBrowser';
  }
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

  open(url: string): void {
    this.run(['open', url]);
  }

  // Navega a una URL que puede mostrar un JS confirm dialog durante la carga.
  // Captura el error provocado por el dialog y lo deja pendiente para que el
  // llamador resuelva con dialogAccept(). La pista del dialog/timeout viene en
  // la salida del CLI, que ErrorDeBrowser expone en `salida` (y en el message).
  openWithPendingDialog(url: string): void {
    try {
      this.run(['open', url]);
    } catch (err: unknown) {
      const texto = err instanceof ErrorDeBrowser
        ? `${err.message} ${err.salida}`
        : (err instanceof Error ? err.message : String(err));
      if (!/timed.?out|ETIMEDOUT|dialog/i.test(texto)) throw err;
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
