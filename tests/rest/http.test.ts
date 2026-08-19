import * as http from 'http';
import { EventEmitter } from 'events';
import { leerBody, responderJson, BodyDemasiadoGrande } from '../../src/rest/http';

function requestConBody(server: http.Server, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.request({ hostname: '127.0.0.1', port, method: 'POST' }, res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode ?? 0, body: data }); });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });
}

describe('leerBody', () => {
  it('devuelve el body completo cuando está bajo el límite', async () => {
    const server = http.createServer(async (req, res) => {
      const body = await leerBody(req, 4_096);
      responderJson(res, 200, { recibido: body });
    });
    const { status, body } = await requestConBody(server, JSON.stringify({ a: 1 }));
    expect(status).toBe(200);
    expect(JSON.parse(body).recibido).toBe(JSON.stringify({ a: 1 }));
  });

  it('rechaza con BodyDemasiadoGrande cuando excede el límite', async () => {
    const server = http.createServer(async (req, res) => {
      try {
        await leerBody(req, 10);
        responderJson(res, 200, {});
      } catch (e) {
        responderJson(res, e instanceof BodyDemasiadoGrande ? 413 : 500, {});
      }
    });
    const { status } = await requestConBody(server, 'x'.repeat(1000));
    expect(status).toBe(413);
  });

  it('no corrompe un carácter multibyte partido justo en el borde entre dos chunks', async () => {
    // 'ñ' en UTF-8 son los bytes [0xC3, 0xB1]. Si cada chunk se decodificara
    // por separado (en vez de acumular Buffers y decodificar recién al
    // final), cada mitad del carácter se leería como bytes UTF-8 inválidos.
    const texto = '{"rut":"11.111.111-1","empresa":"Peña"}';
    const bytesCompletos = Buffer.from(texto, 'utf-8');
    // Corta justo después del primer byte de los 2 que forman 'ñ' en UTF-8.
    const prefijo = texto.slice(0, texto.indexOf('ñ'));
    const indicePartido = Buffer.byteLength(prefijo, 'utf-8') + 1;

    const fakeReq = new EventEmitter();
    const promesa = leerBody(fakeReq as any, 4_096);

    // Corta el buffer completo justo a la mitad del carácter multibyte de "ñ".
    fakeReq.emit('data', bytesCompletos.subarray(0, indicePartido));
    fakeReq.emit('data', bytesCompletos.subarray(indicePartido));
    fakeReq.emit('end');

    const resultado = await promesa;
    expect(resultado).toBe(texto);
    expect(JSON.parse(resultado).empresa).toBe('Peña');
  });
});
