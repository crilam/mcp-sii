import * as fs from 'fs';
import * as path from 'path';
import { F29PpmScraper } from '../../src/scrapers/f29Ppm';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// El fixture se lee de `docs/relevamientos/fixtures/` y NO de una copia en
// `tests/`: es la respuesta real redactada que el relevamiento publica como
// contrato, y duplicarla deja dos verdades que se separan sin que nadie lo note.
// `tests/docs/fixturesF29.test.ts` ya fija su forma.
const TASA_PPM = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'docs', 'relevamientos', 'fixtures', 'f29-tasa-ppmo.json'),
  'utf-8'));

function conRespuesta(data: unknown, metaData?: unknown) {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.identidad as jest.Mock).mockReturnValue({ rut: '11111111', dv: '1' });
  (http.postSdi as jest.Mock).mockResolvedValue(metaData === undefined ? { data } : { data, metaData });
  return { scraper: new F29PpmScraper(http, session), http };
}

describe('F29PpmScraper.tasaPpm', () => {
  beforeEach(() => jest.clearAllMocks());

  // El namespace `lob.iva` es la trampa de esta app: con `lob.diii` el SII
  // responde 200 con errors y data vacía. Y `mes`/`anno` van como STRING aunque
  // el SII los devuelva number — verificado contra el SII real.
  it('pide getTasaPPMO al facadeAdapterService con el namespace lob.iva', async () => {
    const { scraper, http } = conRespuesta(TASA_PPM);

    await scraper.tasaPpm('202608');

    expect(http.postSdi).toHaveBeenCalledWith(
      expect.stringContaining('propuestaf29ui/services/data/facadeAdapterService'),
      'cl.sii.sdi.lob.iva.propuestaf29.data.api.interfaces.FacadeAdapterService',
      'getTasaPPMO',
      { rutContribuyente: '11111111', dv: '1', mes: '08', anno: '2026', categoriaTributaria: 1 });
  });

  it('una sola consulta al SII, no dos', async () => {
    const { scraper, http } = conRespuesta(TASA_PPM);

    await scraper.tasaPpm('202608');

    expect((http.postSdi as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('devuelve los casilleros poblados con el valor como STRING', async () => {
    const { scraper } = conRespuesta(TASA_PPM);

    const r = await scraper.tasaPpm('202608');

    // La tasa es el caso que rompe cualquier conversión a entero: se afirma
    // directo y no dentro de un `if`.
    expect(r.casilleros).toContainEqual({ codigo: '115', valor: '0.125' });
    expect(r.casilleros).toContainEqual({ codigo: '563', valor: '84' });
    for (const c of r.casilleros) expect(typeof c.valor).toBe('string');
  });

  // Los `null` del SII son "este código no aplica". Si entraran como casilleros
  // con valor "null", quien cuadre vería códigos que el formulario no tiene.
  it('omite los códigos que el SII manda en null', async () => {
    const { scraper } = conRespuesta(TASA_PPM);

    const r = await scraper.tasaPpm('202608');

    // En el fixture cod750, cod30 y cod68 vienen null.
    expect(r.casilleros.map(c => c.codigo)).not.toContain('750');
    expect(r.casilleros.map(c => c.codigo)).not.toContain('30');
    expect(r.casilleros.map(c => c.codigo)).not.toContain('68');
  });

  // `cod563Propuesto` y `cod115Original` empiezan con `cod` pero NO son
  // casilleros del formulario. Si el scraper dedujera los códigos con un
  // `/^cod/`, aparecerían como códigos "563Propuesto" inventados.
  it('no confunde cod563Propuesto ni cod115Original con casilleros', async () => {
    const { scraper } = conRespuesta({ ...TASA_PPM, cod115Original: '0.100' });

    const r = await scraper.tasaPpm('202608');

    for (const c of r.casilleros) {
      expect(['750', '30', '563', '115', '68', '62']).toContain(c.codigo);
    }
    expect(r.cod563Propuesto).toBe('84');
  });

  it('pasa la tasa IDPC, la categoría y las banderas del período', async () => {
    const { scraper } = conRespuesta(TASA_PPM);

    const r = await scraper.tasaPpm('202608');

    expect(r.tasaIdpc).toBe('27.0');
    expect(r.categoriaTributaria).toBe(1);
    expect(r.periodo).toBe('202608');
    // El fixture es de un período abierto y sin asistente usado: el 563 es una
    // PROPUESTA, no un valor declarado. Es el caso que el consumidor tiene que
    // poder distinguir.
    expect(r.realizado).toBe(false);
    expect(r.fueraDePlazo).toBe(false);
    expect(r.esPropyme).toBe(true);
  });

  // `periodo`, `cod563Propuesto`, `tasaIdpc` y `categoriaTributaria` son
  // nullables en el tipo `TasaPpmF29` a propósito: el SII puede no traerlos.
  // Esto no es un bug que se arregla, es el contrato que la interfaz ya
  // declara — y sin un test que lo ejercite, nadie nota si un cambio futuro
  // empieza a asumir que siempre vienen y explota con un `.toUpperCase()` o
  // similar sobre `null`.
  it('período, 563 propuesto, tasa y categoría tributaria ausentes se devuelven null, no explotan', async () => {
    const { scraper } = conRespuesta({
      ...TASA_PPM, periodo: null, cod563Propuesto: null, tasaIDPC: null, categoriaTributaria: null,
    });

    const r = await scraper.tasaPpm('202608');

    expect(r.periodo).toBeNull();
    expect(r.cod563Propuesto).toBeNull();
    expect(r.tasaIdpc).toBeNull();
    expect(r.categoriaTributaria).toBeNull();
  });

  // Esta app usa "S"/"N" en otros campos (`scoaRealizado`, `scoaPpmoCod750`). Un
  // cast a boolean convertiría el string "N" en `true`.
  it('un "N" del SII en un booleano no se lee como true', async () => {
    const { scraper } = conRespuesta({ ...TASA_PPM, realizado: 'N', fueraDePlazo: 'N' });

    const r = await scraper.tasaPpm('202608');

    expect(r.realizado).toBe(false);
    expect(r.fueraDePlazo).toBe(false);
  });

  // El modo de fallo de esta app es HTTP 200 con errors y data vacía. Sin este
  // control, un error del SII se leería como "el período no tiene PPM".
  it('un error del SII lanza, no devuelve casilleros vacíos', async () => {
    const { scraper } = conRespuesta(null, { errors: [{ descripcion: 'namespace incorrecto' }] });

    await expect(scraper.tasaPpm('202608')).rejects.toThrow(/rechazó la consulta de la tasa de PPM/);
  });

  // `errors: []` es truthy: verificar la existencia en vez del contenido haría
  // fallar toda consulta buena que traiga la lista vacía.
  it('una lista de errors VACÍA no hace fallar la consulta', async () => {
    const { scraper } = conRespuesta(TASA_PPM, { errors: [] });

    await expect(scraper.tasaPpm('202608')).resolves.toBeDefined();
  });

  it('data nula lanza con el período en el mensaje', async () => {
    const { scraper } = conRespuesta(null);

    await expect(scraper.tasaPpm('202608')).rejects.toThrow(/202608/);
  });
});
