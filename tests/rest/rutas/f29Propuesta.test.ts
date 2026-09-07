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

const BASE = { rut: '11.111.111-1', clave: 'secreta', periodo: '202607' };

const RESULTADO = {
  casilleros: [{ codigo: '520', valor: '100000' }, { codigo: '115', valor: '0.125' }],
  tipoPropuesta: 40,
  fechaCreacion: '10/08/2026 10:28:02',
  complementoDetalleDTE: true,
  documentosDelGiro: true,
};

describe('POST /v1/f29/propuesta', () => {
  afterEach(() => jest.clearAllMocks());

  it('devuelve los casilleros y la marca de cuándo se consultó', async () => {
    (core.propuesta as jest.Mock).mockResolvedValue(RESULTADO);

    const r = await armarRouter().get('POST /v1/f29/propuesta')!(BASE);
    const body = r.body as any;

    expect(body.ok).toBe(true);
    expect(body.casilleros).toEqual(RESULTADO.casilleros);
    expect(body.tipo_propuesta).toBe(40);
    expect(body.fecha_creacion).toBe('10/08/2026 10:28:02');
    expect(body.complemento_detalle_dte).toBe(true);
    expect(body.documentos_del_giro).toBe(true);
    expect(Date.parse(body.generada_en)).not.toBeNaN();
  });

  // Es la razón de ser del código propio: un período sin propuesta NO es un
  // fallo, y marcarlo como ERROR haría que el consumidor reintente algo que
  // nunca va a cambiar por reintentar.
  it('sin propuesta responde ok:false con SIN_PROPUESTA, no un error genérico', async () => {
    (core.propuesta as jest.Mock).mockResolvedValue({ ...RESULTADO, casilleros: null });

    const r = await armarRouter().get('POST /v1/f29/propuesta')!(BASE);
    const body = r.body as any;

    expect(r.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('SIN_PROPUESTA');
    // El marcador interno no puede escaparse al JSON del consumidor.
    expect(JSON.stringify(body)).not.toContain('__sin_propuesta');
    // "Preguntamos y no había propuesta" también es un hecho fechable.
    expect(Date.parse(body.generada_en)).not.toBeNaN();
  });

  // La ruta arma la respuesta campo por campo en vez de spreadear el resultado
  // del core. Este test lo fija: si alguien cambiara a `...r`, cualquier campo
  // nuevo del SII —incluida la traza— saldría solo.
  //
  // La no-filtración de la traza y de listCodBase se prueba en el test del
  // SCRAPER, contra el fixture real: acá el core está mockeado y un assert así
  // pasaría por construcción.
  it('devuelve sólo los campos del contrato, y nunca la credencial', async () => {
    (core.propuesta as jest.Mock).mockResolvedValue({ ...RESULTADO, traza: 'RUT[11111111-1]' });

    const r = await armarRouter().get('POST /v1/f29/propuesta')!(BASE);
    const body = r.body as any;

    expect(Object.keys(body).sort()).toEqual([
      'casilleros', 'complemento_detalle_dte', 'documentos_del_giro',
      'fecha_creacion', 'generada_en', 'ok', 'tipo_propuesta',
    ]);
    const json = JSON.stringify(body);
    expect(json).not.toContain('traza');
    expect(json).not.toContain('secreta');
  });

  // Los dos contratos de período conviven bajo /v1/f29: estado-declaracion pide
  // number y ésta string. Se aceptan ambos para que la diferencia no sea una
  // trampa.
  it('acepta el período como number y lo normaliza a string', async () => {
    (core.propuesta as jest.Mock).mockResolvedValue(RESULTADO);

    const r = await armarRouter().get('POST /v1/f29/propuesta')!({ ...BASE, periodo: 202607 });

    expect(r.status).toBe(200);
    expect(core.propuesta).toHaveBeenCalledWith(expect.anything(), expect.anything(), '202607');
  });

  it('exige el período y lo valida como AAAAMM', async () => {
    const rutas = armarRouter();

    for (const periodo of [undefined, '2026-07', '202613', '200612', '20267']) {
      const r = await rutas.get('POST /v1/f29/propuesta')!({ ...BASE, periodo });
      expect(r.status).toBe(400);
    }
    expect(core.propuesta).not.toHaveBeenCalled();
  });

  it('pasa el período como string al core, sin convertirlo a número', async () => {
    (core.propuesta as jest.Mock).mockResolvedValue(RESULTADO);

    await armarRouter().get('POST /v1/f29/propuesta')!(BASE);

    expect(core.propuesta).toHaveBeenCalledWith(expect.anything(), '11.111.111-1', '202607');
  });

  it('registra la ruta junto a las otras dos de F29', () => {
    expect([...armarRouter().keys()]).toEqual([
      'POST /v1/f29/estado-declaracion',
      'POST /v1/f29/propuesta',
      'POST /v1/f29/formulario-compacto',
    ]);
  });
});
