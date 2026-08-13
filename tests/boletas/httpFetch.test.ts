import { crearHttpFetch } from '../../src/boletas/httpFetch';

describe('crearHttpFetch', () => {
  it('postea con fetch y devuelve status + body como texto', async () => {
    const llamadas: any[] = [];
    const fakeFetch = async (url: string, init: any) => {
      llamadas.push({ url, init });
      return { status: 200, text: async () => '{"ok":true}' } as Response;
    };

    const http = crearHttpFetch(fakeFetch as unknown as typeof fetch);
    const r = await http({
      url: 'https://x/y',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });

    expect(r).toEqual({ status: 200, body: '{"ok":true}' });
    expect(llamadas[0].url).toBe('https://x/y');
    expect(llamadas[0].init.method).toBe('POST');
    expect(llamadas[0].init.body).toBe('{"a":1}');
    expect(llamadas[0].init.headers['Content-Type']).toBe('application/json');
  });
});
