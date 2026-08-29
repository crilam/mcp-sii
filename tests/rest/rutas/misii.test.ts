import { registrarRutasMisii } from '../../../src/rest/rutas/misii';
import { RutaHandler } from '../../../src/rest/rutas/comun';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/misii';

jest.mock('../../../src/core/misii');
jest.mock('../../../src/credencialesRuntime');

function armar() {
  const rutas = new Map<string, RutaHandler>();
  const registro = { ejecutar: jest.fn() } as unknown as RegistroSesiones<any>;
  const credenciales = new ProveedorCredencialesRuntime();
  registrarRutasMisii(rutas, registro, credenciales);
  return rutas;
}

describe('registrarRutasMisii', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra la ruta de datos del contribuyente', () => {
    expect([...armar().keys()]).toEqual(['POST /v1/misii/datos-contribuyente']);
  });

  // La ficha es un objeto y se spreadea en el body, como el resto de las rutas
  // que devuelven un objeto (no una lista).
  it('acepta clave tributaria y spreadea la ficha', async () => {
    (core.datosContribuyente as jest.Mock).mockResolvedValue({ rut: '11111111-1', razonSocial: 'X', direcciones: [] });

    const r = await armar().get('POST /v1/misii/datos-contribuyente')!({ rut: '11.111.111-1', clave: 'secreta' });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, rut: '11111111-1', razonSocial: 'X', direcciones: [] });
  });

  it('acepta certificado', async () => {
    (core.datosContribuyente as jest.Mock).mockResolvedValue({ rut: '11111111-1' });

    const r = await armar().get('POST /v1/misii/datos-contribuyente')!({
      rut: '11.111.111-1', certificado_base64: Buffer.from('x').toString('base64'), certificado_password: 'p',
    });

    expect(r.status).toBe(200);
  });

  it('sin credencial es 400', async () => {
    const r = await armar().get('POST /v1/misii/datos-contribuyente')!({ rut: '11.111.111-1' });

    expect(r.status).toBe(400);
    expect(core.datosContribuyente).not.toHaveBeenCalled();
  });
});
