import { registrarRutasContribuyente } from '../../../src/rest/rutas/situacionTributaria';
import * as core from '../../../src/core/situacionTributaria';
import { RecursoNoEncontrado } from '../../../src/erroresConsulta';

jest.mock('../../../src/core/situacionTributaria');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasContribuyente(rutas as any);
  return rutas;
}

const SITUACION = {
  rut: '76632059-7',
  razonSocial: 'INFOSEC SERVICIOS DE SEGURIDAD INFORMATICA SPA',
  inicioActividades: true,
  fechaInicioActividades: '08-07-2016',
  proPyme: true,
  monedaExtranjera: false,
  actividades: [{ giro: 'X', codigo: 262000, categoria: 1, afectaIva: true }],
};

describe('registrarRutasContribuyente', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra POST /v1/contribuyente/situacion-tributaria', () => {
    expect([...armarRouter().keys()]).toEqual(['POST /v1/contribuyente/situacion-tributaria']);
  });

  it('body válido llama al core y envuelve en {ok:true}', async () => {
    (core.situacionTributaria as jest.Mock).mockResolvedValue(SITUACION);
    const respuesta = await armarRouter().get('POST /v1/contribuyente/situacion-tributaria')!({ rut: '76632059-7' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, ...SITUACION } });
    expect(core.situacionTributaria).toHaveBeenCalledWith('76632059-7');
  });

  it('sin rut → 400 BAD_REQUEST sin tocar el core', async () => {
    const respuesta = await armarRouter().get('POST /v1/contribuyente/situacion-tributaria')!({});
    expect(respuesta.status).toBe(400);
    expect((respuesta.body as any).error).toBe('BAD_REQUEST');
    expect(core.situacionTributaria).not.toHaveBeenCalled();
  });

  it('rut mal formado → 400 BAD_REQUEST sin tocar el core', async () => {
    const respuesta = await armarRouter().get('POST /v1/contribuyente/situacion-tributaria')!({ rut: 'no-es-un-rut' });
    expect(respuesta.status).toBe(400);
    expect(core.situacionTributaria).not.toHaveBeenCalled();
  });

  it('RUT sin datos en el SII → 200 {ok:false, NO_ENCONTRADO}', async () => {
    (core.situacionTributaria as jest.Mock).mockRejectedValue(new RecursoNoEncontrado('sin datos'));
    const respuesta = await armarRouter().get('POST /v1/contribuyente/situacion-tributaria')!({ rut: '11111111-1' });
    expect(respuesta.status).toBe(200);
    expect((respuesta.body as any).ok).toBe(false);
    expect((respuesta.body as any).error).toBe('NO_ENCONTRADO');
  });
});
