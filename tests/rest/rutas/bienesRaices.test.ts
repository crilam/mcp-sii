import { registrarRutasBienesRaices } from '../../../src/rest/rutas/bienesRaices';
import { RegistroSesiones } from '../../../src/registroSesiones';
import { ProveedorCredencialesRuntime } from '../../../src/credencialesRuntime';
import * as core from '../../../src/core/bienesRaices';

jest.mock('../../../src/core/bienesRaices');

function armarRouter() {
  const rutas = new Map<string, Function>();
  registrarRutasBienesRaices(rutas as any, {} as RegistroSesiones<any>, new ProveedorCredencialesRuntime());
  return rutas;
}

const RUT = '11.111.111-1';
const CERT_B64 = Buffer.from('x').toString('base64');

describe('registrarRutasBienesRaices', () => {
  afterEach(() => jest.clearAllMocks());

  it('registra exactamente las 7 rutas', () => {
    const rutas = armarRouter();
    expect(new Set(rutas.keys())).toEqual(new Set([
      'POST /v1/persona/bienes-raices',
      'POST /v1/bienes-raices/comunas',
      'POST /v1/bienes-raices/solicitudes',
      'POST /v1/bienes-raices/multipropietarios',
      'POST /v1/bienes-raices/consultar-rol',
      'POST /v1/bienes-raices/certificado-avaluo',
      'POST /v1/bienes-raices/documento',
    ]));
  });

  describe('POST /v1/persona/bienes-raices', () => {
    // Contrato nuevo: la ruta histórica sólo aceptaba clave; ahora también
    // certificado, vía conCredencial igual que el resto del adaptador REST.
    it('acepta clave tributaria', async () => {
      (core.listBienesRaices as jest.Mock).mockResolvedValue({ resumen: {}, propiedades: [] });
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/persona/bienes-raices')!({ rut: RUT, clave: 'secreta' });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    });

    it('acepta certificado', async () => {
      (core.listBienesRaices as jest.Mock).mockResolvedValue({ resumen: {}, propiedades: [] });
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/persona/bienes-raices')!({
        rut: RUT, certificado_base64: CERT_B64, certificado_password: 'p',
      });

      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    });

    it('rechaza clave y certificado juntos, sin llamar al core', async () => {
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/persona/bienes-raices')!({
        rut: RUT, clave: 'secreta', certificado_base64: CERT_B64, certificado_password: 'p',
      });

      expect(r.status).toBe(400);
      expect(core.listBienesRaices).not.toHaveBeenCalled();
    });

    // El resultado del core ({resumen, propiedades}) es un objeto: `ejecutar` lo
    // spreadea flat, no lo envuelve en `datos` (eso es sólo para arrays).
    it('spreadea resumen y propiedades en el body', async () => {
      (core.listBienesRaices as jest.Mock).mockResolvedValue({
        resumen: { total: 1 }, propiedades: [{ rol: '1-1' }],
      });
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/persona/bienes-raices')!({ rut: RUT, clave: 'secreta' });

      expect(r.body).toEqual({
        ok: true, resumen: { total: 1 }, propiedades: [{ rol: '1-1' }],
      });
    });
  });

  // El core devuelve un array; `ejecutar` lo envuelve bajo `datos` porque
  // spreadear un array produce {"0":a,"1":b} en JSON.
  it('/comunas: envuelve el array del core en datos', async () => {
    (core.comunas as jest.Mock).mockResolvedValue([{ codigo: 8201, nombre: 'Providencia' }]);
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/bienes-raices/comunas')!({ rut: RUT, clave: 'secreta' });

    expect(r.body).toEqual({ ok: true, datos: [{ codigo: 8201, nombre: 'Providencia' }] });
  });

  it('/solicitudes: envuelve el array del core en datos', async () => {
    (core.solicitudes as jest.Mock).mockResolvedValue([{ url: '/descarga/documento/a/b' }]);
    const rutas = armarRouter();

    const r = await rutas.get('POST /v1/bienes-raices/solicitudes')!({ rut: RUT, clave: 'secreta' });

    expect(r.body).toEqual({ ok: true, datos: [{ url: '/descarga/documento/a/b' }] });
  });

  describe('/multipropietarios', () => {
    it('pasa comuna, manzana y predio numéricos al core', async () => {
      (core.multipropietarios as jest.Mock).mockResolvedValue([]);
      const rutas = armarRouter();

      await rutas.get('POST /v1/bienes-raices/multipropietarios')!({
        rut: RUT, clave: 'secreta', comuna: 8201, manzana: 632, predio: 244,
      });

      expect(core.multipropietarios).toHaveBeenCalledWith(
        expect.anything(), RUT, { comuna: 8201, manzana: 632, predio: 244 });
    });

    it('sin comuna: 400 sin llamar al core', async () => {
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/bienes-raices/multipropietarios')!({
        rut: RUT, clave: 'secreta', manzana: 632, predio: 244,
      });

      expect(r.status).toBe(400);
      expect(core.multipropietarios).not.toHaveBeenCalled();
    });

    // El schema exige `z.number()`: un string numérico ("8201") no coacciona
    // silenciosamente, se rechaza.
    it('comuna como string: 400', async () => {
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/bienes-raices/multipropietarios')!({
        rut: RUT, clave: 'secreta', comuna: '8201', manzana: 632, predio: 244,
      });

      expect(r.status).toBe(400);
      expect(core.multipropietarios).not.toHaveBeenCalled();
    });
  });

  describe('/consultar-rol', () => {
    it('pasa comuna, manzana y predio numéricos al core', async () => {
      (core.consultarPorRol as jest.Mock).mockResolvedValue([]);
      const rutas = armarRouter();

      await rutas.get('POST /v1/bienes-raices/consultar-rol')!({
        rut: RUT, clave: 'secreta', comuna: 8201, manzana: 632, predio: 244,
      });

      expect(core.consultarPorRol).toHaveBeenCalledWith(
        expect.anything(), RUT, { comuna: 8201, manzana: 632, predio: 244 });
    });

    it('sin comuna: 400 sin llamar al core', async () => {
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/bienes-raices/consultar-rol')!({
        rut: RUT, clave: 'secreta', manzana: 632, predio: 244,
      });

      expect(r.status).toBe(400);
      expect(core.consultarPorRol).not.toHaveBeenCalled();
    });

    it('comuna como string: 400', async () => {
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/bienes-raices/consultar-rol')!({
        rut: RUT, clave: 'secreta', comuna: '8201', manzana: 632, predio: 244,
      });

      expect(r.status).toBe(400);
      expect(core.consultarPorRol).not.toHaveBeenCalled();
    });
  });

  describe('/certificado-avaluo', () => {
    const BIEN = { comuna: 8201, manzana: 632, predio: 244, ultimo_eac_aplicado: 5 };

    // El Buffer se envuelve a mano: `ejecutar` spreadea el resultado, y
    // spreadear un Buffer produce {"0":37,"1":80,...}.
    it('devuelve el PDF en base64, no el Buffer spreadeado, con tipo default simple', async () => {
      (core.certificadoAvaluo as jest.Mock).mockResolvedValue(Buffer.from('%PDF-1.4 x'));
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/bienes-raices/certificado-avaluo')!({
        rut: RUT, clave: 'secreta', bienes: [BIEN],
      });

      expect(r.body).toMatchObject({
        ok: true,
        tipo: 'simple',
        content_type: 'application/pdf',
        nombre_archivo: 'certificado-avaluo-simple.pdf',
        tamano_bytes: 10,
        pdf_base64: Buffer.from('%PDF-1.4 x').toString('base64'),
      });
      expect((r.body as Record<string, unknown>)['0']).toBeUndefined();
      expect(core.certificadoAvaluo).toHaveBeenCalledWith(
        expect.anything(), RUT,
        [{ comuna: 8201, manzana: 632, predio: 244, ultimoEacAplicado: 5 }],
        'simple');
    });

    it('bienes vacío: 400 sin llamar al core', async () => {
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/bienes-raices/certificado-avaluo')!({
        rut: RUT, clave: 'secreta', bienes: [],
      });

      expect(r.status).toBe(400);
      expect(core.certificadoAvaluo).not.toHaveBeenCalled();
    });

    it('tipo inválido: 400 sin llamar al core', async () => {
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/bienes-raices/certificado-avaluo')!({
        rut: RUT, clave: 'secreta', bienes: [BIEN], tipo: 'otro',
      });

      expect(r.status).toBe(400);
      expect(core.certificadoAvaluo).not.toHaveBeenCalled();
    });
  });

  describe('/documento', () => {
    it('pasa la url tal cual al core y arma el nombre de archivo con el folio', async () => {
      (core.descargarDocumento as jest.Mock).mockResolvedValue(Buffer.from('%PDF-1.4 x'));
      const rutas = armarRouter();

      const r = await rutas.get('POST /v1/bienes-raices/documento')!({
        rut: RUT, clave: 'secreta', url: '/descarga/documento/abc-123/V0000001',
      });

      expect(core.descargarDocumento).toHaveBeenCalledWith(
        expect.anything(), RUT, '/descarga/documento/abc-123/V0000001');
      expect(r.body).toMatchObject({
        ok: true,
        nombre_archivo: 'bienes-raices-V0000001.pdf',
        url: '/descarga/documento/abc-123/V0000001',
      });
    });

    // El schema restringe la url a la forma que publica /solicitudes: una url
    // absoluta a otro host, o path traversal, se rechazan antes de tocar el core.
    it.each(['https://evil/x', '/descarga/documento/../../etc'])(
      'url fuera de forma (%p): 400 sin llamar al core', async (url) => {
        const rutas = armarRouter();

        const r = await rutas.get('POST /v1/bienes-raices/documento')!({
          rut: RUT, clave: 'secreta', url,
        });

        expect(r.status).toBe(400);
        expect(core.descargarDocumento).not.toHaveBeenCalled();
      });
  });
});
