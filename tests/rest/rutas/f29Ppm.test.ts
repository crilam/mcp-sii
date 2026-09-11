import { registrarRutasF29 } from '../../../src/rest/rutas/f29';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/f29';

jest.mock('../../../src/core/f29');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasF29(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

const BASE = { rut: '11.111.111-1', clave: 'secreta', periodo: '202608' };

const RESULTADO = {
  periodo: '202608',
  casilleros: [{ codigo: '563', valor: '84' }, { codigo: '115', valor: '0.125' }],
  cod563Propuesto: '84',
  tasaIdpc: '27.0',
  categoriaTributaria: 1,
  realizado: false,
  fueraDePlazo: false,
  esPropyme: true,
};

describe('POST /v1/f29/ppm', () => {
  afterEach(() => jest.clearAllMocks());

  it('devuelve los casilleros, la tasa y la marca de cuándo se consultó', async () => {
    (core.tasaPpm as jest.Mock).mockResolvedValue(RESULTADO);

    const r = await armarRouter().get('POST /v1/f29/ppm')!(BASE);
    const body = r.body as any;

    expect(body.ok).toBe(true);
    expect(body.casilleros).toEqual(RESULTADO.casilleros);
    expect(body.cod563_propuesto).toBe('84');
    expect(body.tasa_idpc).toBe('27.0');
    expect(body.categoria_tributaria).toBe(1);
    expect(body.realizado).toBe(false);
    expect(body.fuera_de_plazo).toBe(false);
    expect(body.es_propyme).toBe(true);
    expect(Date.parse(body.generada_en)).not.toBeNaN();
  });

  // El SII devuelve `rutContribuyente` y `dv` en esta respuesta. La ruta arma el
  // cuerpo campo por campo justamente para que no salgan: el test corre sobre el
  // JSON serializado, que es lo que viaja al consumidor.
  it('no devuelve el RUT del contribuyente aunque el SII lo mande', async () => {
    (core.tasaPpm as jest.Mock).mockResolvedValue({
      ...RESULTADO, rutContribuyente: '11111111', dv: '1',
    });

    const r = await armarRouter().get('POST /v1/f29/ppm')!(BASE);

    const json = JSON.stringify(r.body);
    expect(json).not.toContain('rutContribuyente');
    expect(json).not.toContain('11111111');
  });

  it('un período mal formado es 400 y no llega al SII', async () => {
    const r = await armarRouter().get('POST /v1/f29/ppm')!({ ...BASE, periodo: '2026' });

    expect(r.status).toBe(400);
    expect(core.tasaPpm).not.toHaveBeenCalled();
  });

  // Mismo contrato que la propuesta: el período se acepta como number y se
  // normaliza a string, para no obligar al consumidor a convertir.
  it('acepta el período como number y lo pasa como string AAAAMM', async () => {
    (core.tasaPpm as jest.Mock).mockResolvedValue(RESULTADO);

    await armarRouter().get('POST /v1/f29/ppm')!({ ...BASE, periodo: 202608 });

    expect(core.tasaPpm).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', '202608');
  });
});
