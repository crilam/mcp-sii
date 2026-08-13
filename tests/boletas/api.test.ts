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

describe('BoletaApi.getInfoContribuyente (GET firmado a execute-api)', () => {
  it('firma un GET SigV4 con servicio execute-api y devuelve el JSON', async () => {
    const { http, llamadas } = transporteFalso({
      body: JSON.stringify({ rut: 11111111, dv: '4', sucursales: [], tiposDte: [] }),
    });
    const api = new BoletaApi(http, CRED, () => new Date('2026-08-13T00:00:00Z'));

    const r = await api.getInfoContribuyente('info-emisor-usuario/11111111/22222222-2');

    expect(r).toMatchObject({ rut: 11111111, dv: '4' });
    const llamada = llamadas[0];
    expect(llamada.method).toBe('GET');
    expect(llamada.url).toContain('/prod/api/info-contribuyente/info-emisor-usuario/11111111/22222222-2');
    // Firma de API Gateway, no de Lambda.
    expect(llamada.headers['Authorization']).toContain('/execute-api/aws4_request');
    expect(llamada.headers['X-Amz-Security-Token']).toBe('tok');
    // Un GET no lleva cuerpo.
    expect(llamada.body).toBe('');
  });

  it('falla si el endpoint no devuelve JSON (sesión vencida)', async () => {
    const { http } = transporteFalso({ status: 403, body: 'Missing Authentication Token' });
    const api = new BoletaApi(http, CRED, () => new Date('2026-08-13T00:00:00Z'));

    await expect(api.getInfoContribuyente('emisores-usuario/22222222-2')).rejects.toThrow(/JSON|403|sesión/i);
  });
});

describe('BoletaApi.emitir', () => {
  // Contrato capturado emitiendo una boleta real (folio 2). El body arma
  // Encabezado/Detalle/Meta; info_emisor es el passthrough de la config.
  const infoEmisor = {
    rut: 11111111, dv: '4', razonSocial: 'FICTICIA SPA',
    sucursales: [{ codigo: 92059768, direccion: 'CALLE X' }],
    tiposDte: [{ codigo: 39, nombre: 'Boleta electrónica' }],
  };

  function armar(respGenerar: object) {
    const { http, llamadas } = transporteFalso({ body: JSON.stringify(respGenerar) });
    const api = new BoletaApi(http, CRED, () => new Date('2026-08-13T00:00:00Z'));
    return { api, http, llamadas };
  }

  it('emite una boleta afecta sin receptor y devuelve el folio del servidor', async () => {
    const { api, llamadas } = armar({ folio: 7, dte: {}, pdf_public_url: 'u', b64encoded_pdf: 'x' });

    const r = await api.emitir({
      vendedor: '22222222-2',
      empresaRut: '11111111-1',
      infoEmisor,
      tipoDte: 39,
      medioPago: 1,
      lineas: [{ nombre: 'Monto Total', cantidad: 1, precio: 50 }],
    });

    // El folio real viene del servidor, no del request.
    expect(r.folio).toBe(7);

    const emit = llamadas.find(l => l.url.includes('documentos/generar'))!;
    expect(emit.headers['Authorization']).toContain('/execute-api/aws4_request');
    const body = JSON.parse(emit.body);
    expect(body.vendedor).toBe('22222222-2');
    expect(body.Encabezado.IdDoc).toMatchObject({ TipoDTE: 39, MedioPago: 1 });
    expect(body.Encabezado.Emisor).toEqual({ RUTEmisor: '11111111-1', CdgSIISucur: 92059768 });
    // Sin receptor → el genérico "SII Boleta" 66666666-6.
    expect(body.Encabezado.Receptor).toEqual({
      RUTRecep: '66666666-6', RznSocRecep: 'SII Boleta', DirRecep: 'Santiago',
    });
    expect(body.Detalle).toEqual([{ NmbItem: 'Monto Total', QtyItem: 1, PrcItem: 50 }]);
    expect(body.Meta.info_emisor).toEqual(infoEmisor);
    expect(body.Meta.plataforma).toBe('eboleta_web');
  });

  it('toma el CdgSIISucur de la sucursal del info_emisor', async () => {
    const { api, llamadas } = armar({ folio: 1, dte: {}, pdf_public_url: 'u', b64encoded_pdf: 'x' });

    await api.emitir({
      vendedor: '22222222-2', empresaRut: '11111111-1', infoEmisor,
      tipoDte: 39, medioPago: 1, lineas: [{ nombre: 'x', cantidad: 1, precio: 50 }],
    });

    const body = JSON.parse(llamadas.find(l => l.url.includes('generar'))!.body);
    expect(body.Encabezado.Emisor.CdgSIISucur).toBe(92059768);
  });

  it('usa el receptor real cuando se le pasa uno', async () => {
    const { api, llamadas } = armar({ folio: 1, dte: {}, pdf_public_url: 'u', b64encoded_pdf: 'x' });

    await api.emitir({
      vendedor: '22222222-2', empresaRut: '11111111-1', infoEmisor,
      tipoDte: 39, medioPago: 1, lineas: [{ nombre: 'x', cantidad: 1, precio: 50 }],
      receptor: { rut: '33333333-3', razonSocial: 'RECEPTORA FICTICIA S.A.', direccion: 'Providencia' },
    });

    const body = JSON.parse(llamadas.find(l => l.url.includes('generar'))!.body);
    expect(body.Encabezado.Receptor).toEqual({
      RUTRecep: '33333333-3', RznSocRecep: 'RECEPTORA FICTICIA S.A.', DirRecep: 'Providencia',
    });
  });
});

describe('BoletaApi.emitir — selección de sucursal', () => {
  const base = {
    vendedor: '22222222-2', empresaRut: '11111111-1',
    tipoDte: 39 as const, medioPago: 1,
    lineas: [{ nombre: 'x', cantidad: 1, precio: 50 }],
  };
  function armar() {
    const { http, llamadas } = transporteFalso({
      body: JSON.stringify({ folio: 1, dte: {}, pdf_public_url: 'u', b64encoded_pdf: 'x' }),
    });
    return { api: new BoletaApi(http, CRED, () => new Date('2026-08-13T00:00:00Z')), llamadas };
  }

  it('usa la única sucursal cuando hay una sola', async () => {
    const { api, llamadas } = armar();
    await api.emitir({ ...base, infoEmisor: { sucursales: [{ codigo: 92059768 }] } });
    const body = JSON.parse(llamadas.find(l => l.url.includes('generar'))!.body);
    expect(body.Encabezado.Emisor.CdgSIISucur).toBe(92059768);
  });

  it('exige elegir sucursal cuando hay varias, en vez de tomar la primera', async () => {
    // Emitir con la sucursal equivocada es un acto tributario irreversible. Con
    // varias, hay que elegir explícito.
    const { api } = armar();
    await expect(
      api.emitir({
        ...base,
        infoEmisor: { sucursales: [{ codigo: 111 }, { codigo: 222 }] },
      })
    ).rejects.toThrow(/varias sucursales|elegir|codigoSucursal/i);
  });

  it('usa la sucursal explícita cuando se pasa, aunque haya varias', async () => {
    const { api, llamadas } = armar();
    await api.emitir({
      ...base,
      infoEmisor: { sucursales: [{ codigo: 111 }, { codigo: 222 }] },
      codigoSucursal: 222,
    });
    const body = JSON.parse(llamadas.find(l => l.url.includes('generar'))!.body);
    expect(body.Encabezado.Emisor.CdgSIISucur).toBe(222);
  });

  it('rechaza una sucursal explícita que no existe en el info_emisor', async () => {
    const { api } = armar();
    await expect(
      api.emitir({ ...base, infoEmisor: { sucursales: [{ codigo: 111 }] }, codigoSucursal: 999 })
    ).rejects.toThrow(/999|no.*sucursal/i);
  });

  it('falla si el info_emisor no trae sucursales', async () => {
    const { api } = armar();
    await expect(
      api.emitir({ ...base, infoEmisor: { sucursales: [] } })
    ).rejects.toThrow(/sucursal/i);
  });
});
