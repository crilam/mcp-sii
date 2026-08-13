import { BoletaApi } from '../../src/boletas/api';
import { HttpBoletas } from '../../src/boletas/auth';

const CRED = { accessKeyId: 'ASIA1', secretKey: 'sk', sessionToken: 'tok', expiration: 0 };

function transporteFalso(respuesta: { status?: number; body: string }) {
  const llamadas: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const http: HttpBoletas = async req => {
    llamadas.push(req);
    return { status: respuesta.status ?? 200, body: respuesta.body };
  };
  return { http, llamadas };
}

describe('BoletaApi.invocarLambda', () => {
  it('invoca un Lambda firmando SigV4 con las credenciales de sesión', async () => {
    const { http, llamadas } = transporteFalso({
      body: JSON.stringify({ error: null, body: { config: { ok: true } } }),
    });
    const api = new BoletaApi(http, CRED, () => new Date('2026-08-13T00:00:00Z'));

    const r = await api.invocarLambda('eboleta_getConfigPorContribuyente', {
      contribuyente: 22222222,
      username: '11111111-1',
      env: 'prod',
    });

    // Devuelve el sobre completo del Lambda { error, body }; el llamador toma
    // `.body`. No se extrae acá porque algunas respuestas traen metadatos fuera
    // de `body` que el llamador puede necesitar.
    expect(r).toEqual({ error: null, body: { config: { ok: true } } });

    const llamada = llamadas[0];
    // El endpoint de invocación de Lambda por HTTP.
    expect(llamada.url).toContain('lambda.us-east-1.amazonaws.com');
    expect(llamada.url).toContain('/functions/eboleta_getConfigPorContribuyente/invocations');
    // Firmada: SigV4 con servicio "lambda" y el security token.
    expect(llamada.headers['Authorization']).toContain('AWS4-HMAC-SHA256');
    expect(llamada.headers['Authorization']).toContain('/lambda/aws4_request');
    expect(llamada.headers['X-Amz-Security-Token']).toBe('tok');
    // El payload es el JSON de entrada del Lambda.
    expect(JSON.parse(llamada.body)).toEqual({
      contribuyente: 22222222,
      username: '11111111-1',
      env: 'prod',
    });
  });

  it('falla cuando el Lambda devuelve error en el sobre', async () => {
    // Los Lambda de eboleta responden { error, body }: un error no-nulo es un
    // fallo de negocio que hay que propagar, no un body válido.
    const { http } = transporteFalso({
      body: JSON.stringify({ error: 'contribuyente no habilitado', body: null }),
    });
    const api = new BoletaApi(http, CRED, () => new Date('2026-08-13T00:00:00Z'));

    await expect(
      api.invocarLambda('eboleta_getConfigPorContribuyente', {})
    ).rejects.toThrow(/contribuyente no habilitado/);
  });
});
