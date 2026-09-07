import * as fs from 'fs';
import * as path from 'path';
import { F29PropuestaScraper } from '../../src/scrapers/f29Propuesta';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// Respuesta REAL del SII, redactada. Importa que sea la real y no una inventada:
// los montos vienen como string y varios campos como null, y un fixture "prolijo"
// escondería justo eso.
const PROPUESTA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'f29-propuesta.json'), 'utf-8'));

function armar() {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.identidad as jest.Mock).mockReturnValue({ rut: '11111111', dv: '1' });
  return { scraper: new F29PropuestaScraper(http, session), http, session };
}

// El SII responde el sobre SDI; `postSdi` ya devuelve el objeto completo.
function conRespuestas(propuesta: unknown, declaraciones: unknown = []) {
  const { scraper, http, session } = armar();
  (http.postSdi as jest.Mock)
    .mockResolvedValueOnce({ data: propuesta })
    .mockResolvedValueOnce({ data: declaraciones });
  return { scraper, http, session };
}

describe('F29PropuestaScraper.propuesta', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pide la propuesta con el namespace lob.iva y el formulario 2', async () => {
    const { scraper, http } = conRespuestas(PROPUESTA);

    await scraper.propuesta('202607');

    // El namespace es la trampa de esta app: con `lob.diii` el SII responde 200
    // con errors y data vacía, que se lee como "no hay propuesta".
    expect(http.postSdi).toHaveBeenCalledWith(
      expect.stringContaining('propuestaf29ui/services/data/facadeAdapterService'),
      'cl.sii.sdi.lob.iva.propuestaf29.data.api.interfaces.FacadeAdapterService',
      'getDeclaracionConCondicionesYTipoPropuesta',
      { rutContribuyente: '11111111', dv: '1', formCodigo: '2', mes: '07', anno: '2026' });
  });

  it('devuelve los casilleros con el valor como STRING, sin normalizar el código', async () => {
    const { scraper } = conRespuestas(PROPUESTA);

    const r = await scraper.propuesta('202607');

    expect(r.casilleros).toContainEqual({ codigo: '520', valor: '96995' });
    // La tasa es el caso que rompe cualquier conversión a entero.
    const tasa = r.casilleros!.find(c => c.codigo === '115');
    if (tasa) expect(typeof tasa.valor).toBe('string');
    for (const c of r.casilleros!) {
      expect(typeof c.valor).toBe('string');
      expect(typeof c.codigo).toBe('string');
    }
  });

  it('pasa el tipo de propuesta tal como lo da el SII, sin traducirlo', async () => {
    const { scraper } = conRespuestas(PROPUESTA);

    const r = await scraper.propuesta('202607');

    // 40 es el valor real observado. No se mapea a un enum propio: no conocemos
    // la tabla del SII y un mapeo inventado mentiría.
    expect(r.tipoPropuesta).toBe(40);
  });

  it('un período sin propuesta devuelve casilleros null, no un error', async () => {
    const { scraper } = conRespuestas({ ...PROPUESTA, listCodPropuestos: [] });

    const r = await scraper.propuesta('202608');

    expect(r.casilleros).toBeNull();
  });

  it('tolera que el SII devuelva data null', async () => {
    const { scraper } = conRespuestas(null);

    const r = await scraper.propuesta('202608');

    expect(r.casilleros).toBeNull();
    expect(r.tipoPropuesta).toBeNull();
    expect(r.complementoDetalleDTE).toBe(false);
  });

  // `fechaCreacion` NO viene en la propuesta: es de la declaración. Por eso hay
  // una segunda consulta, y por eso este test existe.
  it('toma fechaCreacion de la declaración, en una segunda consulta', async () => {
    const { scraper, http } = conRespuestas(PROPUESTA,
      [{ folio: 9207107276, estado: 'Vigente', declFechaCreacion: '10/08/2026 10:28:02' }]);

    const r = await scraper.propuesta('202607');

    expect(r.fechaCreacion).toBe('10/08/2026 10:28:02');
    expect(http.postSdi).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'getDeclaracionConEstados',
      { rut: '11111111', dv: '1', formId: '2', mes: '07', anno: '2026' });
  });

  it('un período sin declarar deja fechaCreacion en null', async () => {
    const { scraper } = conRespuestas(PROPUESTA, []);

    const r = await scraper.propuesta('202608');

    expect(r.fechaCreacion).toBeNull();
  });

  it('los booleanos del SII se pasan como vinieron', async () => {
    const { scraper } = conRespuestas(PROPUESTA);

    const r = await scraper.propuesta('202607');

    expect(r.complementoDetalleDTE).toBe(PROPUESTA.complementoDetalleDTE);
    expect(r.documentosDelGiro).toBe(PROPUESTA.documentosDelGiro);
  });
});
