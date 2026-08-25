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
  rut: '22222222-2',
  razonSocial: 'EMPRESA DE EJEMPLO SPA',
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
    const respuesta = await armarRouter().get('POST /v1/contribuyente/situacion-tributaria')!({ rut: '22222222-2' });
    expect(respuesta).toEqual({ status: 200, body: { ok: true, ...SITUACION } });
    expect(core.situacionTributaria).toHaveBeenCalledWith('22222222-2');
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
  // El SII resuelve la consulta por el CUERPO del RUT, así que un DV mal escrito
  // devolvía los datos del contribuyente igual, con el DV ya corregido: la API
  // validaba como bueno un RUT que el SII rechaza después. `partirRut` sólo mira
  // la forma, así que el módulo 11 se chequea acá.
  it('rechaza un DV inválido sin consultar al SII', async () => {
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/contribuyente/situacion-tributaria')!({ rut: '22222222-9' });

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('BAD_REQUEST');
    // El detalle dice cuál era el correcto: es un typo, y saberlo lo resuelve.
    expect(r.body.detalle).toMatch(/d.gito verificador/i);
    expect(core.situacionTributaria).not.toHaveBeenCalled();
  });

  it('acepta un RUT con DV correcto', async () => {
    (core.situacionTributaria as jest.Mock).mockResolvedValue({ rut: '22222222-2' });
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/contribuyente/situacion-tributaria')!({ rut: '22222222-2' });

    expect(r.status).toBe(200);
    expect(core.situacionTributaria).toHaveBeenCalled();
  });

  it('acepta el RUT sin guion y con puntos', async () => {
    (core.situacionTributaria as jest.Mock).mockResolvedValue({ rut: '22222222-2' });
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/contribuyente/situacion-tributaria')!({ rut: '22.222.222-2' });

    expect(r.status).toBe(200);
  });
});
