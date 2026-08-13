import { HttpBoletas } from './auth';

// Transporte real de boletas sobre fetch nativo (Node 24). Los hosts
// (clave.w.sii.cl, execute-api, cognito-identity) son AWS/CloudFront con TLS
// estándar y responden JSON, así que no hace falta el curl con cookie jar que
// usa el portal CGI: un POST con fetch alcanza.
//
// `fetch` se inyecta para poder testear sin red; por defecto usa el global.
export function crearHttpFetch(fetchImpl: typeof fetch = fetch): HttpBoletas {
  return async ({ url, method, headers, body }) => {
    const respuesta = await fetchImpl(url, { method, headers, body });
    return { status: respuesta.status, body: await respuesta.text() };
  };
}
