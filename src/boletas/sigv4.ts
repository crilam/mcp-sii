import { createHash, createHmac } from 'crypto';
import { CredencialesAws } from './auth';

// Firma AWS Signature Version 4, con node:crypto y sin dependencias externas.
// SigV4 es fácil de escribir mal —y una firma mal armada la rechaza AWS con un
// error genérico—, así que la correctitud NO se afirma: se prueba contra el test
// vector oficial de AWS (ver tests/boletas/sigv4.test.ts).
//
// Se necesita porque las llamadas a la API de boletas (API Gateway y Lambda) van
// firmadas con SigV4 usando las credenciales STS que produce BoletaAuth.

export interface PeticionFirmable {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface OpcionesFirma {
  region: string;
  service: string;
  // Se inyecta para que los tests sean deterministas y para poder reproducir el
  // test vector de AWS, que fija la fecha.
  fecha: Date;
}

const ALGORITMO = 'AWS4-HMAC-SHA256';

function sha256Hex(dato: string): string {
  return createHash('sha256').update(dato, 'utf8').digest('hex');
}

function hmac(clave: Buffer | string, dato: string): Buffer {
  return createHmac('sha256', clave).update(dato, 'utf8').digest();
}

// AAAAMMDDTHHMMSSZ (amz-date) y AAAAMMDD (datestamp) del mismo instante, en UTC.
function fechasAmz(fecha: Date): { amzDate: string; dateStamp: string } {
  const amzDate = fecha.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function firmarSigV4(
  peticion: PeticionFirmable,
  cred: CredencialesAws,
  opciones: OpcionesFirma
): Record<string, string> {
  const { amzDate, dateStamp } = fechasAmz(opciones.fecha);
  const url = new URL(peticion.url);

  // Los headers que se firman. `host` y `x-amz-date` son obligatorios; el
  // security token de una credencial temporal se firma también, o AWS rechaza.
  const headersFirmados: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
  };
  for (const [nombre, valor] of Object.entries(peticion.headers)) {
    headersFirmados[nombre.toLowerCase()] = valor;
  }
  if (cred.sessionToken) {
    headersFirmados['x-amz-security-token'] = cred.sessionToken;
  }

  const nombresOrdenados = Object.keys(headersFirmados).sort();
  const signedHeaders = nombresOrdenados.join(';');
  const canonicalHeaders = nombresOrdenados
    .map(n => `${n}:${headersFirmados[n].trim()}\n`)
    .join('');

  // 1. Canonical request.
  const hashedPayload = sha256Hex(peticion.body ?? '');
  const canonicalRequest = [
    peticion.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQueryString(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n');

  // 2. String to sign.
  const scope = `${dateStamp}/${opciones.region}/${opciones.service}/aws4_request`;
  const stringToSign = [ALGORITMO, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  // 3. Signing key (derivación encadenada de HMAC).
  const kDate = hmac(`AWS4${cred.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, opciones.region);
  const kService = hmac(kRegion, opciones.service);
  const kSigning = hmac(kService, 'aws4_request');

  // 4. Firma.
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `${ALGORITMO} Credential=${cred.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const salida: Record<string, string> = {
    Authorization: authorization,
    'X-Amz-Date': amzDate,
  };
  if (cred.sessionToken) salida['X-Amz-Security-Token'] = cred.sessionToken;
  return salida;
}

// Canonical URI: cada segmento del path percent-encodeado según RFC 3986, las
// barras separadoras intactas. Se normaliza (decode y re-encode) para que dos
// formas del mismo path —`/fn:PROD` y `/fn%3APROD`— firmen igual, y para que un
// carácter reservado sin encodear (un ARN calificado con ":") no rompa la firma.
// Un path de sólo alfanuméricos, "-", "_" queda idéntico, así que las rutas de
// Lambda actuales no cambian.
function canonicalUri(pathname: string): string {
  const path = pathname || '/';
  return path
    .split('/')
    .map(seg => encodeRfc3986(decodeSeguro(seg)))
    .join('/');
}

function decodeSeguro(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    // Segmento con percent-encoding malformado: se deja como vino en vez de
    // romper la firma entera.
    return seg;
  }
}

// Query string canónica: parámetros ordenados por nombre, cada nombre y valor
// percent-encodeados según RFC 3986. Vacía cuando no hay query.
function canonicalQueryString(params: URLSearchParams): string {
  const pares: Array<[string, string]> = [];
  for (const [k, v] of params) pares.push([k, v]);
  pares.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pares.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
}

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
