import { registrarRutasBienesRaices } from '../../../src/rest/rutas/bienesRaices';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/bienesRaices';

jest.mock('../../../src/core/bienesRaices');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasBienesRaices(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

describe('registrarRutasBienesRaices', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra POST /v1/persona/bienes-raices', () => {
    const rutas = armarRouter();
    expect([...rutas.keys()]).toEqual(['POST /v1/persona/bienes-raices']);
  });

  it('body válido llama al core', async () => {
    (core.listBienesRaices as jest.Mock).mockResolvedValue({ propiedades: [] });
    const rutas = armarRouter();
    const respuesta = await rutas.get('POST /v1/persona/bienes-raices')!({ rut: '11.111.111-1', clave: 'x' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, propiedades: [] } });
  });
});
