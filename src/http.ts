import { execFileSync } from 'child_process';
import { SessionManager } from './session';

const TIMEOUT_MS = 30_000;

// El SII responde ISO-8859-1 en todo, incluidas las APIs que declaran JSON.
const ENCODING = 'latin1' as const;

// Transporte HTTP contra el SII. No sabe nada de ningún dominio del portal ni
// de cómo se autenticó la sesión: sólo pide el cookie jar a su dueño.
export class SiiHttpClient {
  constructor(private session: SessionManager) {}

  async get(url: string, params?: Record<string, string>): Promise<string> {
    const query = params ? `?${this.encodeParams(params)}` : '';
    return this.curl([`${url}${query}`]);
  }

  async postForm(url: string, campos: Record<string, string>): Promise<string> {
    return this.curl(['-d', this.encodeParams(campos), url]);
  }

  private async curl(args: string[]): Promise<string> {
    const jar = await this.session.rutaCookieJar();
    // execFileSync con arreglo de argumentos previene inyección de shell: ningún
    // valor pasa por un intérprete de comandos, así que metacaracteres como
    // comillas, backticks, $(...) o ; son literales y seguros.
    return execFileSync(
      'curl',
      ['-sk', '-b', jar, '-L', '--max-redirs', '5', '--max-time', '25', ...args],
      { encoding: ENCODING, timeout: TIMEOUT_MS }
    );
  }

  private encodeParams(params: Record<string, string>): string {
    return Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }
}
