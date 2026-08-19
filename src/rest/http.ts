import * as http from 'http';

export class BodyDemasiadoGrande extends Error {}

export function leerBody(req: http.IncomingMessage, maxBytes = 4_096): Promise<string> {
  return new Promise((resolve, reject) => {
    let datos = '';
    let bytes = 0;
    let demasiadoGrande = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      // Deja de acumular (evita el gasto de memoria) pero no corta el socket:
      // cortarlo a mitad de stream rompe la conexión antes de poder responder
      // 413 — mejor drenar el resto y responder recién en 'end'.
      if (bytes > maxBytes) {
        demasiadoGrande = true;
        return;
      }
      datos += chunk;
    });
    req.on('end', () => {
      if (demasiadoGrande) {
        reject(new BodyDemasiadoGrande());
        return;
      }
      resolve(datos);
    });
    req.on('error', reject);
  });
}

export function responderJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
