import { registrarRutasRcvEscritura } from '../../../src/rest/rutas/rcvEscritura';
import { RutaHandler } from '../../../src/rest/rutas/comun';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/rcvEscritura';

jest.mock('../../../src/core/rcvEscritura');
jest.mock('../../../src/credencialesRuntime');

function armar() {
  const rutas = new Map<string, RutaHandler>();
  registrarRutasRcvEscritura(rutas, { ejecutar: jest.fn() } as unknown as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}
const CRED = { rut: '11.111.111-1', clave: 'x' };
const DOCS = [{ rut_emisor: '22222222-2', tipo_doc: 33, folio: 100 }];

describe('registrarRutasRcvEscritura', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 2 rutas de escritura del RCV', () => {
    expect(new Set(armar().keys())).toEqual(new Set(['POST /v1/rcv/eventos-acuse', 'POST /v1/rcv/acuse']));
  });

  // Sin confirmar → simula, y la traza de auditoría marca 'simulado'.
  it('acuse sin confirmar simula y audita como simulado', async () => {
    (core.acusar as jest.Mock).mockResolvedValue({ ejecutado: false, evento: 'ERM', documentos: [], mensaje: 'sim' });

    const r = await armar().get('POST /v1/rcv/acuse')!({ ...CRED, documentos: DOCS, evento: 'ERM' });

    expect((r.body as any).ok).toBe(true);
    expect(r.auditoria).toEqual({ efecto: 'simulado', referencia: 'ERM:22222222-2/33-100' });
    // confirmar llegó como false (default) al core.
    expect(core.acusar).toHaveBeenCalledWith(expect.anything(), '11.111.111-1',
      [{ rutEmisor: '22222222-2', tipoDoc: 33, folio: 100 }], 'ERM', false);
  });

  it('acuse con confirmar:true audita como ejecutado', async () => {
    (core.acusar as jest.Mock).mockResolvedValue({ ejecutado: true, evento: 'ERM', documentos: [], mensaje: 'ok' });

    const r = await armar().get('POST /v1/rcv/acuse')!({ ...CRED, documentos: DOCS, evento: 'ERM', confirmar: true });

    expect(r.auditoria).toEqual({ efecto: 'ejecutado', referencia: 'ERM:22222222-2/33-100' });
    expect(core.acusar).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', expect.anything(), 'ERM', true);
  });

  // Un error del core (p.ej. idempotencia) no lleva traza de escritura.
  it('un acuse fallido no marca auditoría de escritura', async () => {
    (core.acusar as jest.Mock).mockRejectedValue(new (require('../../../src/erroresConsulta').LimitacionConocida)('ya cursado'));

    const r = await armar().get('POST /v1/rcv/acuse')!({ ...CRED, documentos: DOCS, evento: 'ERM', confirmar: true });

    expect((r.body as any).ok).toBe(false);
    expect(r.auditoria).toBeUndefined();
  });

  it('documentos vacíos es 400', async () => {
    const r = await armar().get('POST /v1/rcv/acuse')!({ ...CRED, documentos: [], evento: 'ERM' });
    expect(r.status).toBe(400);
    expect(core.acusar).not.toHaveBeenCalled();
  });
});
