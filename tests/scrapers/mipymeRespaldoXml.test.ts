import * as fs from 'fs';
import * as path from 'path';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';
import { LimitacionConocida } from '../../src/erroresConsulta';
import { esperar } from '../../src/ritmoSii';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');
// La pausa entre tramos es real en producción y acá sólo haría lento el test.
// Se anula `esperar` y NO `pausaConfigurada`: así el scraper sigue pidiendo el
// ritmo —si alguien lo saca, el test de ritmo lo nota— pero no se duerme.
jest.mock('../../src/ritmoSii', () => ({
  ...jest.requireActual('../../src/ritmoSii'),
  esperar: jest.fn(() => Promise.resolve()),
}));

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', nombre), 'utf-8');
}

const SEL_EMPRESA = fixture('mipyme-sel-empresa.html');
const SET_DTE = fixture('mipyme-respaldo-setdte.xml');
const DEMASIADOS = fixture('mipyme-respaldo-demasiados.html');

function binarioXml(xml: string = SET_DTE) {
  return {
    contenido: Buffer.from(xml, 'latin1'),
    contentType: 'application/octet-stream;filename=DTE_Recibidos_33333333.xml',
  };
}

function binarioDemasiados() {
  return {
    contenido: Buffer.from(DEMASIADOS, 'latin1'),
    contentType: 'text/html; charset=ISO-8859-1',
  };
}

function armar() {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.conEmpresaExclusiva as jest.Mock) = jest.fn((fn: () => Promise<unknown>) => fn());
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {});
  (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);
  (http.postForm as jest.Mock).mockResolvedValue('<html></html>');
  const scraper = new MipymeHttpScraper(http, session);
  return { scraper, http, session };
}

const RANGO = { empresaRut: '33333333-3', origen: 'RCP' as const, fechaDesde: '2026-08-01', fechaHasta: '2026-08-31' };

describe('MipymeHttpScraper.respaldoXml', () => {
  // `esperar` es un mock de módulo: vive fuera de `armar()` y acumula las
  // llamadas de todos los tests si no se limpia. Sin esto, los asserts sobre
  // cuántas pausas hubo miden el archivo entero, no el caso.
  beforeEach(() => jest.clearAllMocks());

  it('baja el XML por download.cgi con ORIGEN y DOWNLOAD=XML', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

    const r = await scraper.respaldoXml(RANGO);

    expect(http.getBinario).toHaveBeenCalledWith(
      expect.stringContaining('download.cgi'),
      expect.objectContaining({
        RUT_EMP: '33333333', DV_EMP: '3', ORIGEN: 'RCP', DOWNLOAD: 'XML',
        FEC_DESDE: '2026-08-01', FEC_HASTA: '2026-08-31',
      }), { charset: 'latin1' });
    expect(r.tramos).toHaveLength(1);
    expect(r.tramos[0].xml).toContain('<SetDTE>');
    expect(r.documentos).toBe(2);
  });

  // El menú enlaza /Portal001/auth.html, que sólo redirige por JavaScript. El
  // CGI que de verdad abre el contexto de descarga es auth.cgi, y sin pasar por
  // él download.cgi no entrega nada. El orden es parte del contrato.
  it('pasa por auth.cgi y lista_documentos.cgi antes de descargar', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

    await scraper.respaldoXml(RANGO);

    expect(http.postForm).toHaveBeenCalledWith(
      expect.stringContaining('mipeSelEmpresa.cgi'), { RUT_EMP: '33333333-3' });
    expect(http.get).toHaveBeenLastCalledWith(expect.stringContaining('auth.cgi'));
    expect(http.postForm).toHaveBeenCalledWith(
      expect.stringContaining('lista_documentos.cgi'),
      expect.objectContaining({ RUT_EMP: '33333333', DV_EMP: '3', TPO_ARCHIVO: 'dte' }),
      { charset: 'latin1' });
  });

  // El tope de 20 lo impone el SERVIDOR, no el JavaScript de la pantalla: un
  // rango ancho responde una página de error y ningún XML.
  it('parte el rango en dos cuando el SII responde "mas de 20"', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())
      .mockResolvedValueOnce(binarioXml())
      .mockResolvedValueOnce(binarioXml());

    const r = await scraper.respaldoXml(RANGO);

    expect(r.tramos).toHaveLength(2);
    expect(r.documentos).toBe(4);
    // Los dos tramos cubren el rango pedido, sin huecos ni solapamiento.
    expect(r.tramos[0].fechaDesde).toBe('2026-08-01');
    expect(r.tramos[1].fechaHasta).toBe('2026-08-31');
    const finPrimero = new Date(`${r.tramos[0].fechaHasta}T00:00:00Z`);
    const inicioSegundo = new Date(`${r.tramos[1].fechaDesde}T00:00:00Z`);
    expect(inicioSegundo.getTime() - finPrimero.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // El caso donde el Math.floor de la partición importa: con dos días, redondear
  // hacia arriba dejaría la primera mitad vacía y la bisección no avanzaría.
  it('parte un rango de dos días en un día y un día', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())
      .mockResolvedValueOnce(binarioXml())
      .mockResolvedValueOnce(binarioXml());

    const r = await scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-10', fechaHasta: '2026-08-11' });

    expect(r.tramos.map(t => [t.fechaDesde, t.fechaHasta])).toEqual([
      ['2026-08-10', '2026-08-10'],
      ['2026-08-11', '2026-08-11'],
    ]);
  });

  // La bisección es recursiva: una mitad que sigue excediendo el tope se vuelve
  // a partir. Con un solo nivel de split el test no distinguía recursión de un
  // corte único.
  it('bisecta en dos niveles cuando la primera mitad sigue excediendo el tope', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())  // 08-01..08-31
      .mockResolvedValueOnce(binarioDemasiados())  // 08-01..08-16
      .mockResolvedValueOnce(binarioXml())         // 08-01..08-08
      .mockResolvedValueOnce(binarioXml())         // 08-09..08-16
      .mockResolvedValueOnce(binarioXml());        // 08-17..08-31

    const r = await scraper.respaldoXml(RANGO);

    expect(r.tramos.map(t => [t.fechaDesde, t.fechaHasta])).toEqual([
      ['2026-08-01', '2026-08-08'],
      ['2026-08-09', '2026-08-16'],
      ['2026-08-17', '2026-08-31'],
    ]);
    expect(r.documentos).toBe(6);
  });

  // La pausa entre descargas es la mitad de la protección contra el bloqueo del
  // SII (la otra es el techo de tramos). Sin este assert, sacar el `await
  // esperar(...)` no rompía ningún test y el barrido quedaba a toda velocidad.
  it('pausa entre descargas, y no antes de la primera', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())
      .mockResolvedValueOnce(binarioXml())
      .mockResolvedValueOnce(binarioXml());

    await scraper.respaldoXml(RANGO);

    // 3 descargas ⇒ 2 pausas: la primera llamada no espera.
    expect(esperar).toHaveBeenCalledTimes(2);
    expect(esperar).toHaveBeenCalledWith(expect.any(Number));
    expect((esperar as jest.Mock).mock.calls[0][0]).toBeGreaterThanOrEqual(1_200);
  });

  it('no pausa cuando el rango se resuelve en una sola descarga', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

    await scraper.respaldoXml(RANGO);

    expect(esperar).not.toHaveBeenCalled();
  });

  // Las mismas invariantes que valida la ruta REST, sostenidas por el scraper:
  // lo llaman también el core y los scripts, sin pasar por el schema. Un filtro
  // a medias no da error en el portal, da resultados equivocados.
  it('rechaza un rango de folios a medias o invertido, sin tocar el SII', async () => {
    const { scraper, http } = armar();

    await expect(scraper.respaldoXml({ ...RANGO, folioHasta: 20 }))
      .rejects.toThrow(/folioHasta requiere folioDesde/);
    await expect(scraper.respaldoXml({ ...RANGO, folioDesde: 20, folioHasta: 10 }))
      .rejects.toThrow(/invertido/);
    expect(http.getBinario).not.toHaveBeenCalled();
  });

  it('rechaza un maxTramos por encima del techo del scraper', async () => {
    const { scraper, http } = armar();

    await expect(scraper.respaldoXml({ ...RANGO, maxTramos: 500 }))
      .rejects.toThrow(/entre 1 y 48/);
    expect(http.getBinario).not.toHaveBeenCalled();
  });

  // Los tramos tienen que quedar contiguos SIEMPRE, no sólo en el split de un
  // nivel: un hueco entre dos tramos son documentos que faltan en el respaldo y
  // que nadie nota, porque cada tramo por separado se lee perfectamente bien.
  it('deja los tramos contiguos y en orden, sin huecos', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())
      .mockResolvedValueOnce(binarioDemasiados())
      .mockResolvedValue(binarioXml());

    const r = await scraper.respaldoXml(RANGO);

    expect(r.tramos[0].fechaDesde).toBe('2026-08-01');
    expect(r.tramos[r.tramos.length - 1].fechaHasta).toBe('2026-08-31');
    const DIA_MS = 24 * 60 * 60 * 1000;
    for (let i = 1; i < r.tramos.length; i++) {
      const finAnterior = Date.parse(`${r.tramos[i - 1].fechaHasta}T00:00:00Z`);
      const inicio = Date.parse(`${r.tramos[i].fechaDesde}T00:00:00Z`);
      expect(inicio - finAnterior).toBe(DIA_MS);
    }
  });

  // Una fecha imposible pasa el chequeo de formato pero rompe la aritmética del
  // troceo: Date.parse da NaN y toISOString sobre NaN lanza RangeError, un error
  // que no le dice al caller qué mandó mal.
  it('rechaza una fecha que no existe en el calendario', async () => {
    const { scraper, http } = armar();

    await expect(scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-02-31' }))
      .rejects.toThrow(/calendario|2026-02-31/);
    expect(http.getBinario).not.toHaveBeenCalled();
  });

  it('decodifica como UTF-8 si el SII lo declara, y como latin1 por defecto', async () => {
    const { scraper, http } = armar();
    const conAcento = '<?xml version="1.0" encoding="UTF-8"?><SetDTE><DTE><RznSoc>Asesorías</RznSoc></DTE></SetDTE>';
    (http.getBinario as jest.Mock).mockResolvedValue({
      contenido: Buffer.from(conAcento, 'utf-8'),
      contentType: 'application/octet-stream; charset=UTF-8',
    });

    const r = await scraper.respaldoXml(RANGO);

    expect(r.tramos[0].xml).toContain('Asesorías');
  });

  // El camino REAL de producción: el SII responde ISO-8859-1. Sin este caso, el
  // test de encoding sólo cubría la rama nueva y no la que corre siempre.
  it('decodifica latin1 cuando no hay charset declarado', async () => {
    const { scraper, http } = armar();
    const conAcento = '<?xml version="1.0" encoding="ISO-8859-1"?><SetDTE><DTE><RznSoc>Asesorías</RznSoc></DTE></SetDTE>';
    (http.getBinario as jest.Mock).mockResolvedValue({
      contenido: Buffer.from(conAcento, 'latin1'),
      contentType: 'application/octet-stream',
    });

    const r = await scraper.respaldoXml(RANGO);

    expect(r.tramos[0].xml).toContain('Asesorías');
  });

  // Los tramos que ya se bajaron ya NO se pierden cuando otro sub-rango topa:
  // vuelven en `tramos`, y el que topó queda en `limitaciones` con precisión
  // para que el consumidor pueda reintentarlo acotado.
  it('cuando un sub-rango topa sin fondo, lo bajado se devuelve y el resto queda como limitación', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())  // el rango entero (dos días)
      .mockResolvedValueOnce(binarioXml())         // el primer día, OK
      .mockResolvedValue(binarioDemasiados());     // el segundo día, sin fondo

    const r = await scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-01', fechaHasta: '2026-08-02' });

    expect(r.tramos).toHaveLength(1);
    expect(r.tramos[0]).toMatchObject({ fechaDesde: '2026-08-01', fechaHasta: '2026-08-01' });
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ fechaDesde: '2026-08-02', fechaHasta: '2026-08-02' });
    expect(r.documentos).toBe(2);
  });

  // Un solo día con más de 20 documentos no se puede partir más: el filtro por
  // fecha se agotó. Se registra como limitación con el motivo, en vez de
  // tirar todo el respaldo.
  it('registra una limitación con mensaje accionable cuando un solo día excede el tope', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioDemasiados());

    const r = await scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-05', fechaHasta: '2026-08-05' });

    expect(r.tramos).toHaveLength(0);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].fechaDesde).toBe('2026-08-05');
    expect(r.limitaciones[0].fechaHasta).toBe('2026-08-05');
    expect(r.limitaciones[0].motivo).toMatch(/2026-08-05.*más de 20|más de 20.*2026-08-05/s);
  });

  // Con maxTramos:3 la bisección corta en CUATRO hojas contiguas (08-01..04,
  // 08-05..08, 08-09..16, 08-17..31), todas con el mismo motivo ("necesita más
  // de 3 tramos"). Sin fusionar, el consumidor pediría 4 sub-rangos donde el
  // rango entero de vuelta —el que ya tenía— alcanza con uno solo.
  it('fusiona en una sola limitación las hojas contiguas con el mismo motivo por tope de tramos', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioDemasiados());

    const r = await scraper.respaldoXml({ ...RANGO, maxTramos: 3 });

    expect(r.tramos).toHaveLength(0);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ fechaDesde: '2026-08-01', fechaHasta: '2026-08-31' });
    expect(r.limitaciones[0].motivo).toMatch(/tramos/i);
  });

  // Dos limitaciones del mismo TIPO (día suelto que excede el tope) pero
  // separadas por un tramo que sí se bajó (08-02, entre medio) NO se fusionan:
  // fusionarlas inventaría un rango (08-01..08-03) que incluye un día que sí se
  // descargó. El motivo de cada una ya trae la fecha propia, así que ni
  // siquiera coinciden como texto — la fusión exige match exacto e igual no
  // alcanzaría a confundirlas.
  it('no fusiona limitaciones no contiguas aunque compartan motivo', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())  // 08-01..08-03, se parte
      .mockResolvedValueOnce(binarioDemasiados())  // 08-01..08-02, se parte
      .mockResolvedValueOnce(binarioDemasiados())  // 08-01 (día suelto), sin fondo
      .mockResolvedValueOnce(binarioXml())         // 08-02 (día suelto), OK
      .mockResolvedValueOnce(binarioDemasiados()); // 08-03 (día suelto), sin fondo

    const r = await scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-01', fechaHasta: '2026-08-03' });

    expect(r.tramos).toHaveLength(1);
    expect(r.tramos[0]).toMatchObject({ fechaDesde: '2026-08-02', fechaHasta: '2026-08-02' });
    expect(r.limitaciones).toHaveLength(2);
    expect(r.limitaciones[0]).toMatchObject({ fechaDesde: '2026-08-01', fechaHasta: '2026-08-01' });
    expect(r.limitaciones[1]).toMatchObject({ fechaDesde: '2026-08-03', fechaHasta: '2026-08-03' });
    expect(r.limitaciones[0].motivo).toMatch(/día/);
    expect(r.limitaciones[1].motivo).toMatch(/día/);
  });

  // Motivos DISTINTOS no se fusionan aunque las fechas sean contiguas: un día
  // lleno al lado de un corte por tope de tramos son instrucciones distintas
  // ("pedí ese día con tipo_dte" vs. "acortá el rango"), y fusionarlos perdería
  // esa distinción.
  it('no fusiona limitaciones contiguas con motivos distintos', async () => {
    const { scraper, http } = armar();
    // 08-05: un día suelto que excede el tope (motivo "día"). 08-06..08-11 (el
    // resto del rango original de dos tramos) agota maxTramos con otro motivo.
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())  // 08-05..08-06, se parte
      .mockResolvedValueOnce(binarioDemasiados());  // 08-05..08-05, día suelto sin fondo

    const r = await scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-05', fechaHasta: '2026-08-06', maxTramos: 2 });

    // El día 08-05 topa por sí solo (motivo "día") y 08-06 queda sin pedir
    // porque se agotó maxTramos (motivo "tramos"): son contiguas pero con
    // motivos distintos, así que no se fusionan.
    expect(r.limitaciones).toHaveLength(2);
    expect(r.limitaciones[0]).toMatchObject({ fechaDesde: '2026-08-05', fechaHasta: '2026-08-05' });
    expect(r.limitaciones[1]).toMatchObject({ fechaDesde: '2026-08-06', fechaHasta: '2026-08-06' });
    expect(r.limitaciones[0].motivo).not.toBe(r.limitaciones[1].motivo);
  });

  // Cuando NINGÚN tope se toca, `limitaciones` es `[]` y todo lo demás sigue
  // igual que antes del cambio: es la regresión que asegura que un respaldo
  // sano no cambió de forma.
  it('sin ningún tope, limitaciones es un arreglo vacío', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

    const r = await scraper.respaldoXml(RANGO);

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
  });

  // `maxTramos` alcanzado a mitad de camino: lo bajado se devuelve, y la
  // limitación describe exactamente el rango que quedó sin pedir (no el rango
  // pedido completo, ni uno aproximado).
  it('maxTramos alcanzado a mitad de camino devuelve lo bajado y limita sólo lo pendiente', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())  // 08-01..08-31
      .mockResolvedValueOnce(binarioXml());        // 08-01..08-16, OK — se agota el tope acá

    const r = await scraper.respaldoXml({ ...RANGO, maxTramos: 2 });

    expect(r.tramos).toHaveLength(1);
    expect(r.tramos[0]).toMatchObject({ fechaDesde: '2026-08-01', fechaHasta: '2026-08-16' });
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ fechaDesde: '2026-08-17', fechaHasta: '2026-08-31' });
  });

  // Éste NO: se verificó en vivo que el mismo rango falla una vez y responde el
  // XML al reintentarlo. Marcarlo permanente le diría al consumidor que no
  // reintente algo que sí se resuelve reintentando.
  it('una respuesta que no es SetDTE queda como error reintentable', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue({
      contenido: Buffer.from('<html>Error al contribuyente</html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.respaldoXml(RANGO)).rejects.not.toBeInstanceOf(LimitacionConocida);
  });

  it('rechaza un rango invertido antes de tocar el SII', async () => {
    const { scraper, http } = armar();

    await expect(scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-31', fechaHasta: '2026-08-01' }))
      .rejects.toThrow(/rango/i);
    expect(http.getBinario).not.toHaveBeenCalled();
  });

  // Sin este chequeo, la página de error del portal viajaría como si fuera el
  // respaldo: es texto, se guarda igual, y el consumidor lo descubre recién al
  // parsearlo.
  it('rechaza una respuesta que no es un SetDTE', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue({
      contenido: Buffer.from('<html><body>Su requerimiento no ha sido bien recepcionado</body></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.respaldoXml(RANGO)).rejects.toThrow(/SetDTE|no devolvió/i);
  });

  it('pasa el tipo de documento como TPO_DOC cuando se pide', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

    await scraper.respaldoXml({ ...RANGO, tipoDte: 33 });

    expect(http.getBinario).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ TPO_DOC: '33' }), { charset: 'latin1' });
  });

  describe('filtros', () => {
    // El portal quiere el cuerpo del RUT sin DV. Mandarlo con guión no da error:
    // da CERO resultados, y un respaldo vacío se lee igual que "no hubo
    // documentos en el período" — el peor modo de fallo posible acá.
    it('manda la contraparte sin dígito verificador, venga como venga', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

      await scraper.respaldoXml({ ...RANGO, contraparteRut: '77.777.777-7' });
      expect(http.getBinario).toHaveBeenCalledWith(
        expect.any(String), expect.objectContaining({ RUT_RECP: '77777777' }), { charset: 'latin1' });

      await scraper.respaldoXml({ ...RANGO, contraparteRut: '77777777' });
      expect(http.getBinario).toHaveBeenLastCalledWith(
        expect.any(String), expect.objectContaining({ RUT_RECP: '77777777' }), { charset: 'latin1' });
    });

    // La afirmación central del nombre `contraparteRut`: el MISMO campo del
    // portal sirve para los dos lados. Verificado contra el SII para RCP (filtra
    // por emisor); acá se fija que el scraper no cambie de campo según el
    // origen, que es lo que haría inútil el nombre neutro.
    it('usa el mismo campo de contraparte para el lado emitido', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

      await scraper.respaldoXml({ ...RANGO, origen: 'ENV', contraparteRut: '77777777-7' });

      expect(http.getBinario).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ ORIGEN: 'ENV', RUT_RECP: '77777777' }), { charset: 'latin1' });
    });

    // Los dos CGI tienen que pedir el MISMO rango: `lista_documentos.cgi` fija
    // el contexto de búsqueda del lado del servidor, y si sólo la descarga
    // llevara el extremo superior, la búsqueda quedaría "de ese folio en
    // adelante" y dependeríamos de cuál de las dos manda.
    it('manda el rango de folios completo también al fijar la búsqueda', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

      await scraper.respaldoXml({ ...RANGO, folioDesde: 10, folioHasta: 20 });

      expect(http.postForm).toHaveBeenCalledWith(
        expect.stringContaining('lista_documentos.cgi'),
        expect.objectContaining({ FOLIO: '10', FOLIOHASTA: '20' }),
        { charset: 'latin1' });
    });

    // Las dos llamadas van en ISO-8859-1 porque estos CGI leen latin1 y
    // `razonSocial` es el primer texto libre que pasa por acá. Con el default
    // UTF-8, "Muñoz" viaja como `Mu%C3%B1oz`, el portal lo lee como `MuÃ±oz` y
    // devuelve cero documentos — indistinguible de "no hubo documentos". Las
    // razones sociales chilenas con ñ y tildes son la norma, no el borde, y una
    // verificación con un nombre ASCII (como "Banchile") no lo detecta.
    it('manda la razón social en latin1, no en UTF-8', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

      await scraper.respaldoXml({ ...RANGO, razonSocial: 'Muñoz' });

      expect(http.postForm).toHaveBeenCalledWith(
        expect.stringContaining('lista_documentos.cgi'),
        expect.objectContaining({ RZN_SOC: 'Muñoz' }),
        { charset: 'latin1' });
      expect(http.getBinario).toHaveBeenCalledWith(
        expect.stringContaining('download.cgi'),
        expect.objectContaining({ RZN_SOC: 'Muñoz' }),
        { charset: 'latin1' });
    });

    it('pasa razón social y el rango de folios', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

      await scraper.respaldoXml({ ...RANGO, razonSocial: 'Proveedor', folioDesde: 10, folioHasta: 20 });

      expect(http.getBinario).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ RZN_SOC: 'Proveedor', FOLIO: '10', FOLIOHASTA: '20' }), { charset: 'latin1' });
    });

    // Sin esto, pedir un folio suelto bajaría de ese folio EN ADELANTE: el CGI
    // interpreta FOLIOHASTA vacío como sin límite superior.
    it('un folio suelto filtra ese folio exacto, no de ahí en adelante', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

      await scraper.respaldoXml({ ...RANGO, folioDesde: 13711545 });

      expect(http.getBinario).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ FOLIO: '13711545', FOLIOHASTA: '13711545' }), { charset: 'latin1' });
    });

    it('sin filtros, los campos van vacíos y no rompen la búsqueda', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

      await scraper.respaldoXml(RANGO);

      expect(http.getBinario).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ RUT_RECP: '', RZN_SOC: '', FOLIO: '', FOLIOHASTA: '' }), { charset: 'latin1' });
    });

    // TPO_ARCHIVO va FIJO en 'dte' y no es un olvido: mandarlo en 'iecv' no
    // cambia nada por este camino —se verificó contra el SII, devuelve los
    // mismos DTE—, porque los libros se bajan por otro CGI
    // (`respaldoLibrosXml.cgi?COD_LBR=...`), uno por código de libro y no por
    // rango de fechas. Exponerlo acá sería prometer libros y entregar
    // documentos.
    it('siempre pide los DTE, nunca los libros', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

      await scraper.respaldoXml(RANGO);

      expect(http.postForm).toHaveBeenCalledWith(
        expect.stringContaining('lista_documentos.cgi'),
        expect.objectContaining({ TPO_ARCHIVO: 'dte' }),
        { charset: 'latin1' });
    });

    // Los filtros tienen que sobrevivir al troceo: si se perdieran al bisecar,
    // el primer tramo vendría filtrado y el resto no, y el respaldo mezclaría
    // documentos de otras contrapartes sin que nada lo indique.
    it('mantiene los filtros en todos los tramos del troceo', async () => {
      const { scraper, http } = armar();
      (http.getBinario as jest.Mock)
        .mockResolvedValueOnce(binarioDemasiados())
        .mockResolvedValue(binarioXml());

      await scraper.respaldoXml({ ...RANGO, contraparteRut: '77777777', tipoDte: 33 });

      const llamadas = (http.getBinario as jest.Mock).mock.calls;
      expect(llamadas).toHaveLength(3);
      for (const [, params] of llamadas) {
        expect(params).toMatchObject({ RUT_RECP: '77777777', TPO_DOC: '33' });
      }
    });
  });

  it('acepta ORIGEN=ENV para el lado emitido', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioXml());

    await scraper.respaldoXml({ ...RANGO, origen: 'ENV' });

    expect(http.getBinario).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ ORIGEN: 'ENV' }), { charset: 'latin1' });
  });
});

// Tercer nivel de troceo: cuando un DÍA con `tipo_dte` puesto sigue excediendo
// el tope, el eje más fino es el folio (emitidos) o la contraparte (recibidos).
// Las filas de estos fixtures se arman a mano en vez de reusar
// mipyme-historial-*.html: esos fixtures tienen sólo dos filas con paginación
// real, y acá hace falta controlar folios y emisores exactos por caso.
describe('MipymeHttpScraper.respaldoXml — tercer nivel de troceo (folio / contraparte)', () => {
  // El tercer nivel queda APAGADO por defecto (ver `tercerNivelHabilitado` en
  // ritmoSii.ts: la combinación tipo_dte+folio/contraparte no está verificada
  // contra el SII real). Los tests de este describe verifican el TROCEO en sí,
  // así que lo prenden acá; los tests del flag mismo lo apagan explícitamente.
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESPALDO_XML_TERCER_NIVEL = '1';
  });
  afterEach(() => { delete process.env.RESPALDO_XML_TERCER_NIVEL; });

  function filaEmitido(folio: number, codigo: number, receptorRut = '77777777-7'): string {
    return `<tr>
      <td><a href="/cgi-bin/Portal001/mipeGesDocEmi.cgi?CODIGO=${codigo}"><img></a></td>
      <td>${receptorRut}</td>
      <td>Receptor ${receptorRut}</td>
      <td>Factura Electronica</td>
      <td>${folio}</td>
      <td>2026-08-05</td>
      <td>1000</td>
      <td>Documento Emitido</td>
    </tr>`;
  }

  function historialEmitidosHtml(folios: number[]): string {
    return `<table>${folios.map((f, i) => filaEmitido(f, 1000 + i)).join('\n')}</table>`;
  }

  function filaRecibido(folio: number, codigo: number, emisorRut: string): string {
    return `<tr>
      <td><a href="/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=${codigo}"><img></a></td>
      <td>${emisorRut}</td>
      <td>Emisor ${emisorRut}</td>
      <td>Factura Electronica</td>
      <td>${folio}</td>
      <td>2026-08-05</td>
      <td>1000</td>
      <td>Documento Recibido</td>
    </tr>`;
  }

  function historialRecibidosHtml(docs: { folio: number; emisorRut: string }[]): string {
    return `<table>${docs.map((d, i) => filaRecibido(d.folio, 2000 + i, d.emisorRut)).join('\n')}</table>`;
  }

  // Un día suelto con `tipoDte` puesto: la secuencia de `http.get` es
  // parseEmpresas → auth.cgi → el listado del día+tipo (una sola página en
  // estos fixtures).
  function mockearListado(http: { get: unknown }, html: string) {
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockResolvedValueOnce(html);
  }

  const DIA = { fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33 };

  it('emitidos: el listado de 45 folios agrupa en 3 descargas por folio, sin limitaciones', async () => {
    const { scraper, http } = armar();
    const folios = Array.from({ length: 45 }, (_, i) => i + 1);
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero, sin folio
      .mockResolvedValue(binarioXml());           // cada grupo de folios

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(3);
    expect(r.documentos).toBe(6); // 3 tramos × 2 <DTE> del fixture SET_DTE

    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(4);
    expect(llamadas[1][1]).toMatchObject({ FOLIO: '1', FOLIOHASTA: '20' });
    expect(llamadas[2][1]).toMatchObject({ FOLIO: '21', FOLIOHASTA: '40' });
    expect(llamadas[3][1]).toMatchObject({ FOLIO: '41', FOLIOHASTA: '45' });
  });

  // El listado y la descarga no cuentan igual (ver el comentario de
  // `acumularTramos`): un grupo de sólo 3 folios puede seguir excediendo el
  // tope de la descarga. Se bisecta por folio hasta llegar a uno solo, que
  // queda como limitación con el folio exacto.
  it('emitidos: un grupo de folios que igual excede se bisecta hasta el folio único', async () => {
    const { scraper, http } = armar();
    mockearListado(http, historialEmitidosHtml([1, 2, 3]));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioDemasiados()) // grupo [1,2,3]
      .mockResolvedValueOnce(binarioDemasiados()) // folio [1] solo, sigue excediendo
      .mockResolvedValueOnce(binarioXml());       // folios [2,3]

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA });

    expect(r.tramos).toHaveLength(1);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({
      fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33, folioDesde: 1, folioHasta: 1,
    });
    expect(r.limitaciones[0].motivo).toMatch(/folio 1/);
    expect(r.limitaciones[0].motivo).toMatch(/excede/);
  });

  it('recibidos: el listado de 3 emisores agrupa en 3 descargas por contraparte', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 1, emisorRut: '11111111-1' },
      { folio: 2, emisorRut: '22222222-2' },
      { folio: 3, emisorRut: '77777777-7' },
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())
      .mockResolvedValue(binarioXml());

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(3);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(4);
    expect(llamadas[1][1]).toMatchObject({ RUT_RECP: '11111111' });
    expect(llamadas[2][1]).toMatchObject({ RUT_RECP: '22222222' });
    expect(llamadas[3][1]).toMatchObject({ RUT_RECP: '77777777' });
  });

  // Un emisor por sí solo excede el tope, así que se bisecta por folio DENTRO
  // de ese emisor (folio + contraparte juntos); el resto de los emisores no se
  // ve afectado.
  it('recibidos: un emisor que por sí solo excede el tope se bisecta por folio', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 10, emisorRut: '11111111-1' },
      { folio: 11, emisorRut: '11111111-1' },
      { folio: 12, emisorRut: '11111111-1' },
      { folio: 1, emisorRut: '22222222-2' },
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioDemasiados()) // emisor 11111111, plano
      .mockResolvedValueOnce(binarioDemasiados()) // emisor 11111111, folios [10,11,12]
      .mockResolvedValueOnce(binarioDemasiados()) // folio [10] solo, sigue excediendo
      .mockResolvedValueOnce(binarioXml())        // folios [11,12]
      .mockResolvedValueOnce(binarioXml());       // emisor 22222222, plano

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });

    expect(r.tramos).toHaveLength(2);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({
      contraparteRut: '11111111-1', folioDesde: 10, folioHasta: 10, tipoDte: 33,
    });
  });

  // Un emisor con MÁS de 20 folios en el día tiene que agruparse de a lo sumo
  // `TOPE_DOCUMENTOS_SII` (igual que ENV) antes de intentar la descarga: pasar
  // los 45 folios de una sola vez excede seguro y quema una llamada condenada
  // a fallar.
  it('recibidos: un emisor con 45 folios se agrupa de a 20 antes de bisectar', async () => {
    const { scraper, http } = armar();
    const docs = Array.from({ length: 45 }, (_, i) => ({ folio: i + 1, emisorRut: '11111111-1' }));
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioDemasiados()) // el emisor, plano
      .mockResolvedValue(binarioXml());           // cada grupo de a lo sumo 20 folios

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(3);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(5); // día entero + emisor plano + 3 grupos
    expect(llamadas[2][1]).toMatchObject({ FOLIO: '1', FOLIOHASTA: '20' });
    expect(llamadas[3][1]).toMatchObject({ FOLIO: '21', FOLIOHASTA: '40' });
    expect(llamadas[4][1]).toMatchObject({ FOLIO: '41', FOLIOHASTA: '45' });
  });

  // Un folio repetido en el listado (una fila por página, u otra razón del
  // portal) no puede duplicar la descarga: sin dedupe, la bisección de un
  // emisor con folios repetidos llegaría a `[10],[10]` — dos descargas
  // idénticas y dos limitaciones iguales para el mismo folio.
  it('recibidos: deduplica folios repetidos antes de bisectar (evita descargas idénticas)', async () => {
    const { scraper, http } = armar();
    // El mismo folio dos veces: sin dedupe, el grupo queda con 2 elementos en
    // vez de 1, y si igual excede se bisecta en DOS llamadas idénticas
    // (folioDesde=folioHasta=10 las dos) en vez de reconocer el folio único que
    // no se puede afinar más. Sólo se mockean 3 respuestas: si el código
    // pidiera una 4ª llamada (la duplicada), el test fallaría al no tener
    // mock para ella.
    const docs = [
      { folio: 10, emisorRut: '11111111-1' },
      { folio: 10, emisorRut: '11111111-1' }, // repetido
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioDemasiados()) // el emisor, plano
      .mockResolvedValueOnce(binarioDemasiados()); // el grupo [10]: folio único que excede

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ contraparteRut: '11111111-1', folioDesde: 10, folioHasta: 10 });
    expect(http.getBinario).toHaveBeenCalledTimes(3);
  });

  // Regresión explícita: sin `tipo_dte` el tercer nivel ni se intenta, aunque
  // el día exceda el tope — sigue la limitación de siempre («pedí con
  // tipo_dte»), y no se llama a ningún listado.
  it('sin tipo_dte no activa el tercer nivel: sigue la limitación "pedí con tipo_dte"', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioDemasiados());

    const r = await scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-05', fechaHasta: '2026-08-05' });

    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/tipo_dte/);
    expect(http.get).not.toHaveBeenCalledWith(expect.stringContaining('mipeAdminDocs'));
  });

  // `maxTramos` puede agotarse DENTRO del tercer nivel (listando o bajando
  // grupos de folios): la limitación tiene que quedar precisa, y nada se
  // lanza — el mismo contrato que en los otros dos niveles.
  it('maxTramos agotado dentro del tercer nivel: limitación precisa y nada se lanza', async () => {
    const { scraper, http } = armar();
    const folios = Array.from({ length: 25 }, (_, i) => i + 1);
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero, consume 1/2

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, maxTramos: 2 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones.length).toBeGreaterThan(0);
    for (const l of r.limitaciones) {
      expect(l.motivo).toMatch(/tramos/i);
      expect(l.fechaDesde).toBe('2026-08-05');
      expect(l.tipoDte).toBe(33);
    }
    // El listado sí alcanzó a pedirse (consumió el 2º y último tramo del
    // presupuesto); lo que se agotó es lo que vino DESPUÉS.
    expect(http.getBinario).toHaveBeenCalledTimes(1);
  });

  // El listado NO filtra por rango de folio, así que trae TODOS los folios del
  // día+tipo (acá, 45). Si `folio_desde`/`folio_hasta` del llamador no se
  // aplicaran ANTES de agrupar, el grupo terminaría con extremos fuera del
  // rango pedido y la descarga bajaría documentos de más.
  it('emitidos: respeta folio_desde/folio_hasta del llamador al agrupar (no se escapa del rango pedido)', async () => {
    const { scraper, http } = armar();
    const folios = Array.from({ length: 45 }, (_, i) => i + 1);
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero, ya con folio 10..15 puesto
      .mockResolvedValueOnce(binarioXml());       // el grupo acotado

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', ...DIA, folioDesde: 10, folioHasta: 15,
    });

    expect(r.tramos).toHaveLength(1);
    expect(r.limitaciones).toEqual([]);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(2);
    expect(llamadas[1][1]).toMatchObject({ FOLIO: '10', FOLIOHASTA: '15' });
  });

  // Mismo caso del lado recibido: el emisor tiene folios fuera del rango
  // pedido (1 y 50) y la bisección tiene que ignorarlos.
  it('recibidos: respeta folio_desde/folio_hasta del llamador al bisectar un emisor', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 1, emisorRut: '11111111-1' },
      { folio: 10, emisorRut: '11111111-1' },
      { folio: 11, emisorRut: '11111111-1' },
      { folio: 50, emisorRut: '11111111-1' },
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioDemasiados()) // el emisor, plano (ya con folio 10..11 puesto)
      .mockResolvedValueOnce(binarioXml());       // el grupo acotado [10,11]

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'RCP', ...DIA, folioDesde: 10, folioHasta: 11,
    });

    expect(r.tramos).toHaveLength(1);
    expect(r.limitaciones).toEqual([]);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(3);
    expect(llamadas[2][1]).toMatchObject({ FOLIO: '10', FOLIOHASTA: '11' });
  });

  // `maxTramos` puede agotarse a mitad de la PAGINACIÓN del listado, no sólo
  // al bajar grupos: cada página cuenta contra el presupuesto igual que una
  // descarga.
  it('emitidos: maxTramos se agota a mitad de la paginación del listado', async () => {
    const { scraper, http } = armar();
    const paginaUno =
      '<table></table>'
      + '<div class="paginacion">'
      + '<a href="/cgi-bin/Portal001/mipeAdminDocsEmi.cgi?NUM_PAG=1">1</a>'
      + '<a href="/cgi-bin/Portal001/mipeAdminDocsEmi.cgi?NUM_PAG=2">2</a>'
      + '</div>';
    mockearListado(http, paginaUno);
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, maxTramos: 2 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/listado/i);
    expect(r.limitaciones[0].motivo).toMatch(/mitad de camino/i);
    // parseEmpresas, auth.cgi, página 1 — nunca llega a pedir la página 2.
    expect(http.get).toHaveBeenCalledTimes(3);
  });

  // El presupuesto también puede agotarse ENTRE dos emisores del lado
  // recibido, después de haber procesado el primero con éxito.
  it('recibidos: maxTramos agotado ENTRE emisores deja una limitación explicando qué quedó sin procesar', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 1, emisorRut: '11111111-1' },
      { folio: 2, emisorRut: '22222222-2' },
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero (1er tramo)
      .mockResolvedValueOnce(binarioXml());       // emisor 11111111 (2º tramo) — el listado ya usó uno

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA, maxTramos: 3 });

    expect(r.tramos).toHaveLength(1);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/tramos/i);
    expect(r.limitaciones[0].motivo).toMatch(/emisores/i);
  });
});

// El tercer nivel está APAGADO por defecto porque la combinación
// tipo_dte+folio/contraparte no está verificada contra el SII real (ver
// `tercerNivelHabilitado` en ritmoSii.ts). Este describe NO toca el flag en
// `beforeEach`: cada test lo deja tal como está o lo prende explícitamente.
describe('MipymeHttpScraper.respaldoXml — flag RESPALDO_XML_TERCER_NIVEL', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => { delete process.env.RESPALDO_XML_TERCER_NIVEL; });

  it('apagado (default): el tercer nivel no se intenta y el motivo explica cómo activarlo', async () => {
    delete process.env.RESPALDO_XML_TERCER_NIVEL;
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioDemasiados());

    const r = await scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/RESPALDO_XML_TERCER_NIVEL/);
    expect(r.limitaciones[0].motivo).toMatch(/DESACTIVADO/i);
    // Ningún listado de folios/emisores: con el flag apagado ni se intenta.
    expect(http.get).not.toHaveBeenCalledWith(expect.stringContaining('mipeAdminDocs'));
  });

  it('prendido con "1": el tercer nivel se activa y trocea por folio', async () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = '1';
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockResolvedValueOnce(`<table>${[1, 2, 3].map((f, i) => `
        <tr>
          <td><a href="/cgi-bin/Portal001/mipeGesDocEmi.cgi?CODIGO=${9000 + i}"><img></a></td>
          <td>77777777-7</td>
          <td>Receptor</td>
          <td>Factura Electronica</td>
          <td>${f}</td>
          <td>2026-08-05</td>
          <td>1000</td>
          <td>Documento Emitido</td>
        </tr>`).join('\n')}</table>`);
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())
      .mockResolvedValueOnce(binarioXml());

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33,
    });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
  });

  // Case-insensitive, igual que el resto de los flags booleanos del proyecto.
  it('prendido con "true" (case-insensitive): también activa el tercer nivel', async () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = 'TRUE';
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockResolvedValueOnce(`<table>${[1].map((f, i) => `
        <tr>
          <td><a href="/cgi-bin/Portal001/mipeGesDocEmi.cgi?CODIGO=${9100 + i}"><img></a></td>
          <td>77777777-7</td>
          <td>Receptor</td>
          <td>Factura Electronica</td>
          <td>${f}</td>
          <td>2026-08-05</td>
          <td>1000</td>
          <td>Documento Emitido</td>
        </tr>`).join('\n')}</table>`);
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())
      .mockResolvedValueOnce(binarioXml());

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33,
    });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
  });
});
