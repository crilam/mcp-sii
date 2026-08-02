import { execFileSync } from 'child_process';
import { SessionManager } from './session';

const TIMEOUT_MS = 30_000;

// El SII responde ISO-8859-1 en todo, incluidas las APIs que declaran JSON.
const ENCODING = 'latin1' as const;

// El `transactionId` sólo necesita ser único por petición: el cliente del
// portal genera un UUID, pero en las pruebas funcionó cualquier cadena única.
// Se arma sin dependencias nuevas (reloj + contador + azar) para que dos
// peticiones dentro del mismo milisegundo no compartan identificador.
let contadorTransacciones = 0;
function nuevoTransactionId(): string {
  contadorTransacciones += 1;
  return `mcp-sii-${Date.now()}-${contadorTransacciones}-${Math.random().toString(36).slice(2, 10)}`;
}

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

  // Las aplicaciones modernas del portal (las de www4.sii.cl/<app>ui/) no
  // reciben los parámetros del método en la raíz del cuerpo: usan un framework
  // interno del SII —lo llaman SDI— que envuelve cada petición en un "sobre"
  // con metaData + data. Los parámetros van anidados dentro de `data`.
  //
  // ADVERTENCIA: si el sobre está incompleto —falta el namespace, falta el
  // conversationId, o los parámetros van en la raíz en vez de dentro de
  // `data`— el SII responde `{"errorMsg": "Acceso no autorizado!"}`. Ese
  // mensaje apunta a un problema de permisos cuando en realidad es de formato:
  // el certificado y la sesión pueden estar perfectos. Antes de sospechar de
  // los permisos, revisá el sobre.
  async postSdi(
    baseUrl: string,
    namespace: string,
    metodo: string,
    data: Record<string, unknown>
  ): Promise<any> {
    // Fuerza la autenticación (si hace falta) ANTES de leer la cookie TOKEN:
    // sin sesión el cookie jar no existe y el conversationId no se puede
    // resolver. Es idempotente: la sesión vigente se reusa.
    await this.session.rutaCookieJar();

    const sobre = {
      metaData: {
        namespace: `${namespace}/${metodo}`,
        // El cliente del portal usa el valor de la cookie TOKEN. Lo resuelve
        // SessionManager, que es el dueño del cookie jar: el transporte no lee
        // el archivo por su cuenta.
        conversationId: this.session.conversationId(),
        transactionId: nuevoTransactionId(),
        // `null` salvo en endpoints paginados, que acá no se usan.
        page: null,
      },
      data,
    };

    const url = `${baseUrl.replace(/\/+$/, '')}/${metodo}`;
    const salida = await this.curl([
      '-H', 'Content-Type: application/json',
      '--data-binary', JSON.stringify(sobre),
      url,
    ]);

    try {
      return JSON.parse(salida);
    } catch {
      // Una respuesta que no es JSON suele ser el HTML del login o de un error
      // del portal. Devolverla cruda al parser lo haría fallar mucho más lejos
      // de la causa, así que se corta acá con un extracto para diagnosticar.
      throw new Error(
        `El SII no devolvió JSON en ${namespace}/${metodo}. ` +
        `La sesión pudo expirar. Respuesta: ${salida.slice(0, 200)}`
      );
    }
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
