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

  // Un intento con confirmar:true que FALLA sí se audita (efecto 'fallido'):
  // para un acto irreversible, "qué se intentó y no cursó" es lo que importa.
  it('un acuse con confirmar:true que falla se audita como fallido', async () => {
    (core.acusar as jest.Mock).mockRejectedValue(new (require('../../../src/erroresConsulta').EscrituraRechazadaPorSii)('rechazado'));

    const r = await armar().get('POST /v1/rcv/acuse')!({ ...CRED, documentos: DOCS, evento: 'ERM', confirmar: true });

    expect((r.body as any).ok).toBe(false);
    expect(r.auditoria).toEqual({ efecto: 'fallido', referencia: 'ERM:22222222-2/33-100' });
  });

  // Una SIMULACIÓN que falla no deja traza (no se intentó escribir).
  it('una simulación fallida no marca auditoría', async () => {
    (core.acusar as jest.Mock).mockRejectedValue(new (require('../../../src/erroresConsulta').LimitacionConocida)('evento inválido'));

    const r = await armar().get('POST /v1/rcv/acuse')!({ ...CRED, documentos: DOCS, evento: 'ERM' });

    expect((r.body as any).ok).toBe(false);
    expect(r.auditoria).toBeUndefined();
  });

  // La referencia se trunca en acuses muy grandes.
  it('la referencia de auditoría se trunca con muchos documentos', async () => {
    (core.acusar as jest.Mock).mockResolvedValue({ ejecutado: true, evento: 'ERM', documentos: [], mensaje: 'ok' });
    const muchos = Array.from({ length: 25 }, (_, i) => ({ rut_emisor: '22222222-2', tipo_doc: 33, folio: i + 1 }));

    const r = await armar().get('POST /v1/rcv/acuse')!({ ...CRED, documentos: muchos, evento: 'ERM', confirmar: true });

    expect((r.auditoria!.referencia)).toMatch(/\+5 más$/);
  });

  it('documentos vacíos es 400', async () => {
    const r = await armar().get('POST /v1/rcv/acuse')!({ ...CRED, documentos: [], evento: 'ERM' });
    expect(r.status).toBe(400);
    expect(core.acusar).not.toHaveBeenCalled();
  });
});
