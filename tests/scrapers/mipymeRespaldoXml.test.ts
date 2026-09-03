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

  // Los tramos ya bajados se pierden al fallar: el error tiene que decir cuáles
  // eran, o el consumidor reintenta el rango entero y repite llamadas al SII que
  // ya habían salido bien.
  it('al fallar informa qué sub-rango sí se había descargado', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados())  // el rango entero
      .mockResolvedValueOnce(binarioXml())         // primera mitad, OK
      .mockResolvedValue(binarioDemasiados());     // segunda mitad, sin fondo

    await expect(scraper.respaldoXml(RANGO)).rejects.toThrow(/2026-08-01\.\.2026-08-16/);
  });

  // Un solo día con más de 20 documentos no se puede partir más: el filtro por
  // fecha se agotó. Falla con el motivo, en vez de devolver un respaldo
  // incompleto que se lee igual que uno completo.
  it('falla con un mensaje accionable cuando un solo día excede el tope', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioDemasiados());

    await expect(scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-05', fechaHasta: '2026-08-05' }))
      .rejects.toThrow(/2026-08-05.*más de 20|más de 20.*2026-08-05/s);
  });

  it('corta con aviso si el troceo supera el tope de tramos', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioDemasiados());

    await expect(scraper.respaldoXml({ ...RANGO, maxTramos: 3 }))
      .rejects.toThrow(/tramos/i);
  });

  // El TIPO del error decide si el consumidor recibe la instrucción o no: un
  // Error genérico sale de la ruta como `ERROR` y SIN detalle, que en este
  // servicio significa "reintentá" — y estos dos fallos no se arreglan
  // reintentando, así que el consumidor entraría en loop contra el SII.
  it('los fallos permanentes del troceo son LimitacionConocida, no Error genérico', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue(binarioDemasiados());

    await expect(scraper.respaldoXml({ ...RANGO, fechaDesde: '2026-08-05', fechaHasta: '2026-08-05' }))
      .rejects.toBeInstanceOf(LimitacionConocida);
    await expect(scraper.respaldoXml({ ...RANGO, maxTramos: 3 }))
      .rejects.toBeInstanceOf(LimitacionConocida);
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
