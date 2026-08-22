import { execFileSync } from 'child_process';
import { SessionManager } from './session';

const TIMEOUT_MS = 30_000;

// `execFileSync` corta la salida en 1 MiB por defecto y lanza ENOBUFS. Mientras
// todo lo que pedíamos era HTML de informes el default alcanzaba, pero el PDF de
// una boleta es el primer payload que puede acercarse: una con logo o anexos
// pasa el megabyte sin nada raro. El fallo además no se explica solo — sale
// como el ERROR genérico del contrato REST, sin mencionar el tamaño.
const MAX_RESPUESTA_BYTES = 16 * 1024 * 1024;

// El charset NO es uniforme en el portal: varía por aplicación, y hay que
// respetar el `Content-Type` de cada respuesta. Medido en vivo:
//
//   consdcvinternetui   (RCV)        application/json;charset=utf-8
//   consultaestadof22ui (Renta F22)  application/json;charset=ISO-8859-1
//   CGI legacy (BHE, loa.sii.cl)     ISO-8859-1
//
// Fijar cualquiera de los dos para todo rompe la otra mitad: leer el UTF-8 del
// RCV como latin1 devuelve "Factura ElectrÃ³nica" (los bytes C3 B3 de la `ó`
// leídos de a uno), y leer el ISO-8859-1 de F22 como UTF-8 rompe igual.
//
// NO "modernizar" este default a UTF-8: los CGI legacy del SII responden
// ISO-8859-1 y muchos ni siquiera declaran charset. Sin declaración, el byte
// suelto 0xF3 sólo es `ó` si se lee como latin1; como UTF-8 es inválido y
// termina en U+FFFD. UTF-8 por defecto corrompería justamente los casos que
// no podemos verificar por header.
const ENCODING_POR_DEFECTO = 'latin1' as const;

// Marca para separar el cuerpo del `content_type` que curl agrega con `-w`.
// Se elige una cadena que no puede aparecer en un Content-Type real, y se
// busca por el ÚLTIMO índice: `-w` escribe siempre después del cuerpo, así que
// aunque el cuerpo contuviera la marca, la que corta es la de curl.
const MARCA_CONTENT_TYPE = '\n__MCP_SII_CONTENT_TYPE__:';

// Se decodifica con `TextDecoder` (nativo en Node, sin dependencias nuevas) y
// no con `Buffer.toString`, que sólo entiende un puñado de encodings. Mantener
// un mapa de equivalencias a mano obligaba a aproximar: windows-1252 mapeado a
// latin1 corrompe en silencio el rango 0x80–0x9F, que en windows-1252 son
// imprimibles (€, comillas tipográficas, rayas) y en latin1 son controles C1.
// Con TextDecoder el label del header se usa tal cual y cualquier charset
// futuro que declare el SII queda cubierto sin tocar este archivo.
const LABEL_POR_DEFECTO = 'iso-8859-1';

// Un label desconocido no debe voltear la consulta: `TextDecoder` lanza ante
// una etiqueta que no reconoce, así que se cae al default —que es lo que la
// respuesta habría usado igual— pero dejando rastro en stderr. Mismo criterio
// que con los códigos de respuesta del RCV: lo desconocido no pasa
// inadvertido, pero tampoco rompe algo que funcionaría.
const labelsAvisados = new Set<string>();

export function decodificarRespuesta(cuerpo: Buffer, contentType: string): string {
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '');
  const label = m ? m[1].toLowerCase() : LABEL_POR_DEFECTO;

  // PASO 1 — sniff de UTF-8, ANTES de mirar el header. El header miente:
  // medido en vivo, Renta F22 (`consultaestadof22ui`) declara
  // `charset=ISO-8859-1` y manda bytes UTF-8 (`0xC3 0xB3` para la `ó`).
  // Honrar la etiqueta al pie de la letra devolvía "declaraciÃ³n". Como el
  // charset declarado no es confiable, se decide por el contenido.
  //
  // Se puede hacer porque UTF-8 es autovalidante: sus secuencias multibyte
  // tienen una forma estricta (byte líder + continuaciones 10xxxxxx) que un
  // texto latin1 con acentos prácticamente nunca satisface — `0xF3` suelto,
  // la `ó` en latin1, es inválido y el sniff lo rechaza. El falso positivo
  // exigiría que el texto latin1 formara, por casualidad, secuencias UTF-8
  // bien armadas de punta a punta.
  //
  // `fatal: true` es lo que hace que esto funcione: sin él los bytes inválidos
  // se convierten en U+FFFD en silencio y el sniff nunca fallaría.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(cuerpo);
  } catch {
    // No es UTF-8 válido: recién ahí se le cree al header.
  }

  // PASO 2 — el charset declarado. PASO 3 (el catch) — el default.
  try {
    return new TextDecoder(label).decode(cuerpo);
  } catch {
    if (!labelsAvisados.has(label)) {
      labelsAvisados.add(label);
      console.error(
        `[mcp-sii] charset declarado desconocido: "${label}". ` +
        `Se decodifica como ${LABEL_POR_DEFECTO}; el texto con acentos puede venir corrupto.`
      );
    }
    return new TextDecoder(LABEL_POR_DEFECTO).decode(cuerpo);
  }
}

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

  // Variante de `get` para respuestas que NO son texto (el PDF de una boleta de
  // honorarios). Devuelve los bytes crudos junto al Content-Type declarado, sin
  // decodificar: pasar un PDF por `TextDecoder` lo destruye —los bytes que no
  // forman secuencias válidas se reemplazan por U+FFFD y no hay vuelta atrás—
  // y el daño es silencioso, porque el resultado sigue siendo un string.
  // Quien llama decide qué hacer con el Content-Type; el transporte no sabe
  // qué tipo esperaba.
  //
  // No expone el `charset` que sí tienen `get`/`postForm`, y no es un olvido:
  // los únicos parámetros que viajan por acá son identificadores del SII
  // (códigos de barras), que son ASCII. Si alguna vez hay que mandar texto con
  // acentos en un GET binario, hay que agregarlo igual que en `postForm`.
  async getBinario(
    url: string,
    params?: Record<string, string>
  ): Promise<{ contenido: Buffer; contentType: string }> {
    const query = params ? `?${this.encodeParams(params)}` : '';
    return this.curlCrudo([`${url}${query}`]);
  }

  // `charset` decide cómo se percent-encodean los valores. El default UTF-8
  // sirve para las aplicaciones modernas; los CGI legacy de Portal001 esperan
  // ISO-8859-1 y hay que decírselo explícitamente.
  //
  // No es cosmético: el POST de emisión reenvía la razón social del emisor tal
  // como el portal la entregó ("ASESORÍAS ..."). Con UTF-8, la `Í` viaja como
  // %C3%8D, que el CGI lee como dos caracteres latin1 y emite un documento
  // tributario con el nombre del contribuyente corrupto. Medido contra
  // mipeDisplayPreView.cgi: con latin1 la razón social vuelve intacta.
  async postForm(
    url: string,
    campos: Record<string, string>,
    opciones?: { charset?: 'utf-8' | 'latin1' }
  ): Promise<string> {
    const cuerpo = this.encodeParams(campos, opciones?.charset ?? 'utf-8');
    // `--data-binary` y no `-d`: `-d` descarta saltos de línea, y acá el cuerpo
    // ya viene percent-encodeado y no debe tocarse.
    return this.curl(['--data-binary', cuerpo, '-H', 'Content-Type: application/x-www-form-urlencoded', url]);
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
    const { contenido, contentType } = await this.curlCrudo(args);
    return decodificarRespuesta(contenido, contentType);
  }

  // Ejecuta curl y separa cuerpo de Content-Type SIN decodificar el cuerpo. Es
  // la base de `curl` (que decodifica) y de `getBinario` (que no).
  private async curlCrudo(args: string[]): Promise<{ contenido: Buffer; contentType: string }> {
    const jar = await this.session.rutaCookieJar();
    // execFileSync con arreglo de argumentos previene inyección de shell: ningún
    // valor pasa por un intérprete de comandos, así que metacaracteres como
    // comillas, backticks, $(...) o ; son literales y seguros.
    // Se pide la salida como bytes crudos (`encoding: 'buffer'`) porque el
    // encoding correcto recién se conoce después de leer el Content-Type que
    // curl agrega con `-w`. Decodificar antes sería adivinar.
    const salida = execFileSync(
      'curl',
      [
        '-sk', '-b', jar, '-L', '--max-redirs', '5', '--max-time', '25',
        '-w', `${MARCA_CONTENT_TYPE}%{content_type}`,
        ...args,
      ],
      { encoding: 'buffer', timeout: TIMEOUT_MS, maxBuffer: MAX_RESPUESTA_BYTES }
    );

    const bruto = Buffer.isBuffer(salida)
      ? salida
      : Buffer.from(String(salida), ENCODING_POR_DEFECTO);

    const corte = bruto.lastIndexOf(MARCA_CONTENT_TYPE);
    if (corte === -1) {
      // Sin marca no hubo `-w` (o curl murió antes de escribirla): no hay
      // Content-Type que respetar y quien llama usa su default.
      return { contenido: bruto, contentType: '' };
    }

    return {
      contenido: bruto.subarray(0, corte),
      contentType: bruto
        .subarray(corte + MARCA_CONTENT_TYPE.length)
        .toString('ascii')
        .trim(),
    };
  }

  private encodeParams(params: Record<string, string>, charset: 'utf-8' | 'latin1' = 'utf-8'): string {
    const encode = charset === 'latin1' ? encodeLatin1 : encodeURIComponent;
    return Object.entries(params)
      .map(([k, v]) => `${encode(k)}=${encode(v)}`)
      .join('&');
  }
}

// `encodeURIComponent` siempre percent-encodea en UTF-8 y no se le puede pedir
// otro charset, así que la codificación latin1 se hace a mano: se convierte el
// texto a bytes ISO-8859-1 y se escapa byte a byte. El conjunto sin escapar es
// el de `encodeURIComponent` (alfanuméricos y `-_.!~*'()`), que es lo que
// esperan estos CGI.
//
// Un carácter que no existe en latin1 (una `ü` está, un emoji no) se convierte
// en `?` al pasar por el Buffer. No se intenta arreglar: son campos de un
// documento tributario, y un reemplazo silencioso es preferible a inventar
// bytes, pero quien los llena debería mandar texto latin1.
const SIN_ESCAPAR = /[A-Za-z0-9\-_.!~*'()]/;

function encodeLatin1(texto: string): string {
  let salida = '';
  for (const caracter of texto) {
    const codigo = caracter.codePointAt(0)!;
    // Fuera del rango latin1 (0–255) no hay byte que represente el carácter:
    // `Buffer.from(x, 'latin1')` lo truncaría al byte bajo en silencio y el CGI
    // recibiría otro carácter. En un documento tributario eso es corrupción muda,
    // así que se corta con un error que nombra el valor ofensor.
    if (codigo > 0xff) {
      throw new Error(
        `El valor "${texto}" tiene un carácter ("${caracter}") que no existe en ` +
        'ISO-8859-1 (latin1), el encoding que exigen los CGI del portal. ' +
        'Revisá el dato: el SII no acepta caracteres fuera de latin1 en un DTE.'
      );
    }
    salida += SIN_ESCAPAR.test(caracter)
      ? caracter
      : `%${codigo.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return salida;
}
