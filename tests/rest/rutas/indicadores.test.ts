import { registrarRutasIndicadores } from '../../../src/rest/rutas/indicadores';
import { RutaHandler } from '../../../src/rest/rutas/comun';
import * as core from '../../../src/core/indicadores';

jest.mock('../../../src/core/indicadores');

function armarRouter() {
  const rutas = new Map<string, RutaHandler>();
  // Sin registro de sesiones ni proveedor de credenciales: la firma de este
  // `registrarRutas*` es distinta a la de los demás justamente porque estas
  // rutas no abren sesión.
  registrarRutasIndicadores(rutas);
  return rutas;
}

describe('registrarRutasIndicadores', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra las 6 rutas bajo /v1/indicadores', () => {
    expect(new Set(armarRouter().keys())).toEqual(new Set([
      'POST /v1/indicadores/uf',
      'POST /v1/indicadores/dolar',
      'POST /v1/indicadores/utm',
      'POST /v1/indicadores/correccion-monetaria',
      'POST /v1/indicadores/impuesto-2da-categoria',
      'POST /v1/indicadores/impuesto-2da-categoria-art52',
    ]));
  });

  // Lo que distingue a esta familia de TODAS las demás rutas del adaptador: no
  // pide `rut` ni credencial. Si alguien "unificara" el patrón agregándole
  // `conCredencial`, este test lo frena — un consumidor tendría que mandar una
  // clave para leer un valor público.
  it('responde sin rut ni credencial', async () => {
    (core.uf as jest.Mock).mockResolvedValue([{ mes: 1, dia: 1, valor: 38384.41 }]);

    const r = await armarRouter().get('POST /v1/indicadores/uf')!({ anio: 2025 });

    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
    // Se envuelve en `datos` porque el core devuelve un array: contrato general.
    expect((r.body as { datos: unknown[] }).datos).toHaveLength(1);
  });

  it('un año fuera de rango es 400 y no llama al core', async () => {
    const r = await armarRouter().get('POST /v1/indicadores/uf')!({ anio: 1800 });

    expect(r.status).toBe(400);
    expect((r.body as { detalle?: string }).detalle).toBeTruthy();
    expect(core.uf).not.toHaveBeenCalled();
  });

  it('sin año es 400', async () => {
    const r = await armarRouter().get('POST /v1/indicadores/dolar')!({});

    expect(r.status).toBe(400);
    expect(core.dolar).not.toHaveBeenCalled();
  });

  // Cada ruta tiene que llamar a SU indicador. Un copy-paste que dejara `uf` en
  // las cuatro devolvería la tabla de la UF cuando alguien pide el dólar: datos
  // con la forma correcta y el contenido de otro indicador.
  it('cada ruta llama al indicador que le corresponde', async () => {
    (core.dolar as jest.Mock).mockResolvedValue([]);
    (core.utm as jest.Mock).mockResolvedValue([]);
    (core.correccionMonetaria as jest.Mock).mockResolvedValue([]);
    (core.impuesto2daCategoria as jest.Mock).mockResolvedValue([]);
    (core.impuesto2daCategoriaArt52 as jest.Mock).mockResolvedValue([]);
    const rutas = armarRouter();

    await rutas.get('POST /v1/indicadores/dolar')!({ anio: 2025 });
    await rutas.get('POST /v1/indicadores/utm')!({ anio: 2025 });
    await rutas.get('POST /v1/indicadores/correccion-monetaria')!({ anio: 2025 });
    await rutas.get('POST /v1/indicadores/impuesto-2da-categoria')!({ anio: 2025 });
    await rutas.get('POST /v1/indicadores/impuesto-2da-categoria-art52')!({ anio: 2025 });

    expect(core.dolar).toHaveBeenCalledWith(2025);
    expect(core.utm).toHaveBeenCalledWith(2025);
    expect(core.correccionMonetaria).toHaveBeenCalledWith(2025);
    // Las dos de segunda categoría son la pareja más fácil de cruzar: el art. 52
    // bis apunta a otra página del SII y trae sólo el período mensual.
    expect(core.impuesto2daCategoria).toHaveBeenCalledWith(2025);
    expect(core.impuesto2daCategoriaArt52).toHaveBeenCalledWith(2025);
    expect(core.uf).not.toHaveBeenCalled();
  });
});
