import * as http from 'http';

export class BodyDemasiadoGrande extends Error {}

export function leerBody(req: http.IncomingMessage, maxBytes = 4_096): Promise<string> {
  return new Promise((resolve, reject) => {
    // Se acumulan los Buffers crudos y se decodifican recién al final con
    // Buffer.concat: decodificar cada chunk por separado (`datos += chunk`,
    // que llama chunk.toString('utf8') chunk por chunk) corrompe un carácter
    // multibyte que quede partido justo en el borde entre dos chunks.
    const chunks: Buffer[] = [];
    let bytes = 0;
    let demasiadoGrande = false;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      // Deja de acumular (evita el gasto de memoria) pero no corta el socket:
      // cortarlo a mitad de stream rompe la conexión antes de poder responder
      // 413 — mejor drenar el resto y responder recién en 'end'.
      if (bytes > maxBytes) {
        demasiadoGrande = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (demasiadoGrande) {
        reject(new BodyDemasiadoGrande());
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', reject);
  });
}

export function responderJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
