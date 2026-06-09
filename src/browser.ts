import { execSync } from 'child_process';

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 30_000 };

export class Browser {
  private run(cmd: string): string {
    return execSync(cmd, EXEC_OPTS).toString().trim();
  }

  open(url: string): void {
    this.run(`agent-browser open ${url}`);
  }

  // Navega a una URL que puede mostrar un JS confirm dialog durante la carga.
  // Captura el error provocado por el dialog (execSync pone el output en err.stderr/stdout,
  // no en err.message) y lo deja pendiente para que el llamador resuelva con dialogAccept().
  openWithPendingDialog(url: string): void {
    try {
      this.run(`agent-browser open ${url}`);
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
    return this.run('agent-browser snapshot');
  }

  click(ref: string): void {
    this.run(`agent-browser click ${ref}`);
  }

  fill(ref: string, text: string): void {
    this.run(`agent-browser fill ${ref} "${text}"`);
  }

  type(ref: string, text: string): void {
    this.run(`agent-browser type ${ref} "${text}"`);
  }

  getText(ref: string): string {
    return this.run(`agent-browser get text ${ref}`);
  }

  select(ref: string, value: string): void {
    this.run(`agent-browser select ${ref} "${value}"`);
  }

  eval(js: string): string {
    const escaped = js.replace(/"/g, '\\"');
    return this.run(`agent-browser eval "${escaped}"`);
  }

  press(key: string): void {
    this.run(`agent-browser press ${key}`);
  }

  dialogAccept(): void {
    this.run('agent-browser dialog accept');
  }

  dialogDismiss(): void {
    this.run('agent-browser dialog dismiss');
  }

  close(): void {
    this.run('agent-browser close');
  }
}
