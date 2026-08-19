import * as http from 'http';
import { crearServidorHttp, validarClave } from '../src/httpServer';
import { ProveedorCredencialesRuntime } from '../src/credencialesRuntime';
import { RegistroSesiones } from '../src/registroSesiones';

function armarRegistro(sesion: { authenticateOnly: jest.Mock; logout: jest.Mock }) {
  return {
    ejecutarPassThrough: async (_rut: string, preparar: () => void, finalizar: () => void, fn: any) => {
      preparar();
      try {
        return await fn(sesion);
      } finally {
        finalizar();
      }
    },
  } as unknown as RegistroSesiones<any>;
}

describe('validarClave', () => {
  it('clave correcta: responde ok:true y deja logout+borrar hechos', async () => {
    const authenticateOnly = jest.fn().mockResolvedValue(undefined);
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'secreta', registro, credenciales);

    expect(resultado).toEqual({ ok: true });
    expect(logout).toHaveBeenCalled();
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow();
  });

  it('clave rechazada por el SII: responde CREDENCIALES_INVALIDAS y limpia igual', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(
      new Error('El SII rechazó la autenticación: clave incorrecta')
    );
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'mala', registro, credenciales);

    expect(resultado).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
    expect(logout).toHaveBeenCalled();
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow();
  });

  it('fallo de infraestructura: responde ERROR y limpia igual', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'x', registro, credenciales);

    expect(resultado).toEqual({ ok: false, error: 'ERROR' });
    expect(logout).toHaveBeenCalled();
  });

  it('logout corre aunque authenticateOnly lance (try/finally, no encadenado)', async () => {
    const orden: string[] = [];
    const authenticateOnly = jest.fn().mockImplementation(async () => {
      orden.push('authenticateOnly');
      throw new Error('boom');
    });
    const logout = jest.fn().mockImplementation(async () => {
      orden.push('logout');
    });
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    await validarClave('11.111.111-1', 'x', registro, credenciales);

    expect(orden).toEqual(['authenticateOnly', 'logout']);
  });

  it('clave correcta pero logout falla: sigue respondiendo ok:true (logout no pisa el resultado)', async () => {
    const authenticateOnly = jest.fn().mockResolvedValue(undefined);
    const logout = jest.fn().mockRejectedValue(new Error('ETIMEDOUT en logout'));
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'secreta', registro, credenciales);

    expect(resultado).toEqual({ ok: true });
  });

  it('clave rechazada y logout también falla: conserva CREDENCIALES_INVALIDAS, no ERROR', async () => {
    const authenticateOnly = jest.fn().mockRejectedValue(
      new Error('El SII rechazó la autenticación: clave incorrecta')
    );
    const logout = jest.fn().mockRejectedValue(new Error('ETIMEDOUT en logout'));
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    const resultado = await validarClave('11.111.111-1', 'mala', registro, credenciales);

    expect(resultado).toEqual({ ok: false, error: 'CREDENCIALES_INVALIDAS' });
  });

  it('guarda y borra la credencial dentro del mismo ejecutarPassThrough (atómico por RUT, no pasos sueltos)', async () => {
    const authenticateOnly = jest.fn().mockImplementation(async () => {
      // Mientras authenticateOnly corre, la credencial ya debe estar guardada.
      await expect(credenciales.para('11.111.111-1')).resolves.toMatchObject({ clave: 'secreta' });
    });
    const logout = jest.fn().mockResolvedValue(undefined);
    const registro = armarRegistro({ authenticateOnly, logout });
    const credenciales = new ProveedorCredencialesRuntime();

    await validarClave('11.111.111-1', 'secreta', registro, credenciales);

    // Y después de terminar, no queda nada guardado.
    await expect(credenciales.para('11.111.111-1')).rejects.toThrow();
  });
});

function request(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/validar-clave', headers: opts.headers },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('crearServidorHttp', () => {
  const API_KEY = 'clave-del-servicio';
  let server: http.Server;
  let port: number;

  function armarRegistroOk() {
    return {
      ejecutarPassThrough: async (_rut: string, preparar: () => void, finalizar: () => void, fn: any) => {
        preparar();
        try {
          return await fn({ authenticateOnly: jest.fn().mockResolvedValue(undefined), logout: jest.fn().mockResolvedValue(undefined) });
        } finally {
          finalizar();
        }
      },
    } as any;
  }

  beforeEach(done => {
    const registro = armarRegistroOk();
    const credenciales = new ProveedorCredencialesRuntime();
    server = crearServidorHttp(registro, credenciales, API_KEY);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach(done => {
    server.close(done);
  });

  it('clave correcta con auth válida responde 200 {ok:true}', async () => {
    const res = await request(port, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rut: '11.111.111-1', clave: 'secreta' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('sin Authorization responde 401', async () => {
    const res = await request(port, { body: JSON.stringify({ rut: '1', clave: '2' }) });
    expect(res.status).toBe(401);
  });

  it('con API key incorrecta responde 401', async () => {
    const res = await request(port, {
      headers: { Authorization: 'Bearer clave-equivocada' },
      body: JSON.stringify({ rut: '1', clave: '2' }),
    });
    expect(res.status).toBe(401);
  });

  it('body sin clave responde 400', async () => {
    const res = await request(port, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ rut: '1' }),
    });
    expect(res.status).toBe(400);
  });

  it('body no-JSON responde 400', async () => {
    const res = await request(port, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: 'esto no es json',
    });
    expect(res.status).toBe(400);
  });

  it('body demasiado grande responde 413', async () => {
    const res = await request(port, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ rut: '1', clave: 'x'.repeat(5_000) }),
    });
    expect(res.status).toBe(413);
  });

  it('ruta desconocida responde 404', async () => {
    const res = await request(port, {
      path: '/otra-cosa',
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(404);
  });
});
