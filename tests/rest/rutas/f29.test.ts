import { registrarRutasF29 } from '../../../src/rest/rutas/f29';
import { RutaHandler } from '../../../src/rest/rutas/comun';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/f29';

jest.mock('../../../src/core/f29');
jest.mock('../../../src/credencialesRuntime');

function armar() {
  const rutas = new Map<string, RutaHandler>();
  registrarRutasF29(rutas, { ejecutar: jest.fn() } as unknown as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}
const CRED = { rut: '11.111.111-1', clave: 'secreta' };

describe('registrarRutasF29', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 2 rutas bajo /v1/f29', () => {
    expect(new Set(armar().keys())).toEqual(new Set(['POST /v1/f29/estado-declaracion', 'POST /v1/f29/formulario-compacto']));
  });

  it('estado-declaracion spreadea el estado y pasa el período', async () => {
    (core.estadoDeclaracion as jest.Mock).mockResolvedValue({ periodo: 202507, folio: 840, estado: 'Vigente' });

    const r = await armar().get('POST /v1/f29/estado-declaracion')!({ ...CRED, periodo: 202507 });

    expect(r.body).toEqual({ ok: true, periodo: 202507, folio: 840, estado: 'Vigente' });
    expect(core.estadoDeclaracion).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', 202507);
  });

  // Un período que no es AAAAMM válido tiene que ser 400, no un ERROR del core.
  it.each([200612, 202513, 2025, 20250700])('un período inválido (%p) es 400', async (periodo) => {
    const r = await armar().get('POST /v1/f29/estado-declaracion')!({ ...CRED, periodo });

    expect(r.status).toBe(400);
    expect(core.estadoDeclaracion).not.toHaveBeenCalled();
  });

  // El Buffer se envuelve a mano; spreadearlo daría {"0":37,...}.
  it('formulario-compacto devuelve el PDF en base64, no el Buffer', async () => {
    (core.compacto as jest.Mock).mockResolvedValue({
      periodo: 202507, folio: 840, estado: 'Vigente', observaciones: 'SINOBS',
      fechaPresentacion: '19/08/2025', moneda: 'CLP', pdf: Buffer.from('%PDF-1.4 x'),
    });

    const r = await armar().get('POST /v1/f29/formulario-compacto')!({ ...CRED, periodo: 202507 });

    expect(r.body).toMatchObject({
      ok: true, periodo: 202507, folio: 840, content_type: 'application/pdf',
      nombre_archivo: 'f29-compacto-202507.pdf', tamano_bytes: 10,
      pdf_base64: Buffer.from('%PDF-1.4 x').toString('base64'),
    });
    expect((r.body as Record<string, unknown>)['0']).toBeUndefined();
  });
});
