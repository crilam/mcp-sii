import { registrarRutasDteVerificacion } from '../../../src/rest/rutas/dteVerificacion';
import { RutaHandler } from '../../../src/rest/rutas/comun';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/dteVerificacion';

jest.mock('../../../src/core/dteVerificacion');
jest.mock('../../../src/credencialesRuntime');

function armar() {
  const rutas = new Map<string, RutaHandler>();
  registrarRutasDteVerificacion(rutas, { ejecutar: jest.fn() } as unknown as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}
const CRED = { rut: '11.111.111-1', clave: 'secreta' };

describe('registrarRutasDteVerificacion', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 2 rutas bajo /v1/dte', () => {
    expect(new Set(armar().keys())).toEqual(new Set(['POST /v1/dte/validez', 'POST /v1/dte/verificar']));
  });

  it('validez traduce snake_case y spreadea el veredicto', async () => {
    (core.validez as jest.Mock).mockResolvedValue({ recibidoPorElSii: true, resultado: 'Documento recibido por el SII' });

    const r = await armar().get('POST /v1/dte/validez')!({ ...CRED, rut_emisor: '33333333-3', tipo_dte: 33, folio: 124 });

    expect(r.body).toEqual({ ok: true, recibidoPorElSii: true, resultado: 'Documento recibido por el SII' });
    expect(core.validez).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', { rutEmisor: '33333333-3', tipoDte: 33, folio: 124 });
  });

  // El SII sólo verifica los tipos que ofrece su formulario: mandar otro daría
  // un veredicto sobre un tipo que el CGI ignoró.
  it('un tipo_dte que el SII no verifica es 400', async () => {
    const r = await armar().get('POST /v1/dte/validez')!({ ...CRED, rut_emisor: '33333333-3', tipo_dte: 39, folio: 1 });

    expect(r.status).toBe(400);
    expect(core.validez).not.toHaveBeenCalled();
  });

  it('verificar exige receptor, fecha YYYY-MM-DD y monto', async () => {
    (core.contenido as jest.Mock).mockResolvedValue({ datosCoinciden: true });
    const rutas = armar();

    const mal = await rutas.get('POST /v1/dte/verificar')!({ ...CRED, rut_emisor: '33333333-3', tipo_dte: 33, folio: 124, rut_receptor: '11111111-1', fecha_emision: '31/07/2025', monto_total: 68366 });
    expect(mal.status).toBe(400);

    const bien = await rutas.get('POST /v1/dte/verificar')!({ ...CRED, rut_emisor: '33333333-3', tipo_dte: 33, folio: 124, rut_receptor: '11111111-1', fecha_emision: '2025-07-31', monto_total: 68366 });
    expect(bien.body).toEqual({ ok: true, datosCoinciden: true });
    expect(core.contenido).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', {
      rutEmisor: '33333333-3', tipoDte: 33, folio: 124, rutReceptor: '11111111-1', fechaEmision: '2025-07-31', montoTotal: 68366,
    });
  });
});
