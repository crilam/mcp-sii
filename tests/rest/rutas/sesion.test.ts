import { registrarRutasSesion } from '../../../src/rest/rutas/sesion';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';

function armarRouter(sesion: { authenticateOnly: jest.Mock; logout: jest.Mock }) {
  const rutas = new Map<string, Function>();
  const registro = {
    ejecutarPassThrough: async (_rut: string, preparar: () => void, finalizar: () => void, fn: any) => {
      preparar();
      try { return await fn(sesion); } finally { finalizar(); }
    },
  } as unknown as RegistroSesiones<any>;
  registrarRutasSesion(rutas as any, registro, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasSesion', () => {
  it('registra POST /v1/sesion/validar-clave', () => {
    const rutas = armarRouter({ authenticateOnly: jest.fn(), logout: jest.fn() });
    expect([...rutas.keys()]).toEqual(['POST /v1/sesion/validar-clave']);
  });

  it('clave correcta: responde {ok:true}', async () => {
    const rutas = armarRouter({
      authenticateOnly: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
    });
    const respuesta = await rutas.get('POST /v1/sesion/validar-clave')!({ rut: '11.111.111-1', clave: 'x' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true } });
  });

  it('body inválido devuelve 400', async () => {
    const rutas = armarRouter({ authenticateOnly: jest.fn(), logout: jest.fn() });
    const respuesta = await rutas.get('POST /v1/sesion/validar-clave')!({ rut: '11.111.111-1' });
    expect(respuesta.status).toBe(400);
  });
});
