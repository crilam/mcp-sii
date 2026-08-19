import { execSync } from 'child_process';

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 30_000 };

export class Browser {
  constructor(private sessionId?: string) {}

  private run(args: string): string {
    const prefijoSesion = this.sessionId ? `--session ${this.sessionId} ` : '';
    return execSync(`agent-browser ${prefijoSesion}${args}`, EXEC_OPTS).toString().trim();
  }

  open(url: string): void {
    this.run(`open ${url}`);
  }

  // Navega a una URL que puede mostrar un JS confirm dialog durante la carga.
  // Captura el error provocado por el dialog (execSync pone el output en err.stderr/stdout,
  // no en err.message) y lo deja pendiente para que el llamador resuelva con dialogAccept().
  openWithPendingDialog(url: string): void {
    try {
      this.run(`open ${url}`);
    } catch (err: unknown) {
      const allText = [
        err instanceof Error ? err.message : String(err),
        (err as any)?.stderr?.toString() ?? '',
        (err as any)?.stdout?.toString() ?? '',
      ].join(' ');
      if (!/timed.?out|ETIMEDOUT|dialog/i.test(allText)) throw err;
    }
  }

  snapshot(): string {
    return this.run('snapshot');
  }

  click(ref: string): void {
    this.run(`click ${ref}`);
  }

  fill(ref: string, text: string): void {
    this.run(`fill ${ref} "${text}"`);
  }

  type(ref: string, text: string): void {
    this.run(`type ${ref} "${text}"`);
  }

  getText(ref: string): string {
    return this.run(`get text ${ref}`);
  }

  select(ref: string, value: string): void {
    this.run(`select ${ref} "${value}"`);
  }

  eval(js: string): string {
    const escaped = js.replace(/"/g, '\\"');
    return this.run(`eval "${escaped}"`);
  }

  press(key: string): void {
    this.run(`press ${key}`);
  }

  dialogAccept(): void {
    this.run('dialog accept');
  }

  dialogDismiss(): void {
    this.run('dialog dismiss');
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
    this.run('close');
  }
}
