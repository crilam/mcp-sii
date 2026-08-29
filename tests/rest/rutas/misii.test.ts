import { registrarRutasMisii } from '../../../src/rest/rutas/misii';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/misii';

jest.mock('../../../src/core/misii');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasMisii(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

const FICHA = { rut: '22222222-2', razonSocial: 'EMPRESA DE EJEMPLO S.A.', regimen: null };

describe('registrarRutasMisii', () => {
  afterEach(() => jest.clearAllMocks());

  // Una sola ruta: los tres payloads vienen en la misma página del portal, así
  // que partirla en varias gastaría una sesión del SII por cada pedazo.
  it('registra una sola ruta bajo /v1/misii', () => {
    expect(new Set(armarRouter().keys())).toEqual(new Set([
      'POST /v1/misii/ficha-contribuyente',
    ]));
  });

  it('body válido llama al core y devuelve {ok:true, ...ficha}', async () => {
    (core.fichaContribuyente as jest.Mock).mockResolvedValue(FICHA);

    const respuesta = await armarRouter().get('POST /v1/misii/ficha-contribuyente')!(
      { rut: '11.111.111-1', clave: 'secreta' });

    expect(respuesta).toEqual({ status: 200, body: { ok: true, ...FICHA } });
  });

  // Acepta las dos credenciales, como el resto de las consultas desde el PR #55.
  it('acepta certificado además de clave', async () => {
    (core.fichaContribuyente as jest.Mock).mockResolvedValue(FICHA);

    const respuesta = await armarRouter().get('POST /v1/misii/ficha-contribuyente')!(
      { rut: '11.111.111-1', certificado_base64: 'eHh4', certificado_password: 'yyy' });

    expect(respuesta).toEqual({ status: 200, body: { ok: true, ...FICHA } });
  });

  it('sin credencial es BAD_REQUEST y no toca el core', async () => {
    const respuesta = await armarRouter().get('POST /v1/misii/ficha-contribuyente')!(
      { rut: '11.111.111-1' });

    expect(respuesta).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } });
    expect(core.fichaContribuyente).not.toHaveBeenCalled();
  });

  it('sin rut es BAD_REQUEST', async () => {
    const respuesta = await armarRouter().get('POST /v1/misii/ficha-contribuyente')!(
      { clave: 'secreta' });

    expect(respuesta).toMatchObject({ status: 400, body: { error: 'BAD_REQUEST' } });
  });
});
