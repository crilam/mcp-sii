import * as fs from 'fs';
import * as path from 'path';
import {
  MipymeHttpScraper, LimitacionRespaldoXml, soloCuerpoRut, acotarPorFolio, enGrupos,
} from '../../src/scrapers/mipymeHttp';
import { LimitacionConocida, PortalSiiNoDisponible } from '../../src/erroresConsulta';
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

// Global, a nivel de archivo: sólo el describe del tercer nivel prende
// `RESPALDO_XML_TERCER_NIVEL` y lo limpia en SU `afterEach`, pero eso lo hace
// inmune al orden sólo porque hoy Jest corre un archivo en un único worker
// con orden determinista. Este `afterEach` de archivo entero es la red que
// no depende de ese orden: si algún test futuro seteara la variable sin
// limpiarla, no se filtraría al resto de los tests del archivo.
afterEach(() => { delete process.env.RESPALDO_XML_TERCER_NIVEL; });

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', nombre), 'utf-8');
}

const SEL_EMPRESA = fixture('mipyme-sel-empresa.html');
const SET_DTE = fixture('mipyme-respaldo-setdte.xml');
const DEMASIADOS = fixture('mipyme-respaldo-demasiados.html');
const PORTAL_NO_DISPONIBLE = fixture('mipyme-portal-no-disponible.html');

function binarioXml(xml: string = SET_DTE) {
  return {
    contenido: Buffer.from(xml, 'latin1'),
    contentType: 'application/octet-stream;filename=DTE_Recibidos_33333333.xml',
  };
}

// Un SetDTE armado con folios y tipo A MEDIDA, a diferencia de `SET_DTE`
// (fijo, tipo 34, folios 1 y 2): sirve para tests que necesitan reconocer un
// documento puntual por su folio (`ID="S<folio>"`) dentro del XML devuelto,
// por ejemplo para confirmar que uno en particular sigue ahí.
function xmlSetDteConFolios(tipoDte: number, folios: number[]): string {
  const documentos = folios.map(folio => `<DTE version="1.0" >
	<Documento ID="S${folio}">
		<Encabezado>
			<IdDoc><TipoDTE>${tipoDte}</TipoDTE><Folio>${folio}</Folio><FchEmis>2026-08-05</FchEmis></IdDoc>
			<Emisor><RUTEmisor>77777777-7</RUTEmisor><RznSoc>Emisor De Prueba</RznSoc></Emisor>
		</Encabezado>
		<Detalle><NroLinDet>1</NroLinDet><NmbItem>ITEM DE PRUEBA</NmbItem><MontoItem>1000</MontoItem></Detalle>
	</Documento>
</DTE>`).join('\n');
  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<SetDTE>\n${documentos}\n</SetDTE>\n`;
}

function binarioXmlConFolios(tipoDte: number, folios: number[]) {
  return binarioXml(xmlSetDteConFolios(tipoDte, folios));
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

  // Fusionar sólo por `fechaDesde`/`fechaHasta` contiguas + mismo `motivo`
  // textual no alcanza: la fusión conserva `tipoDte`/`folioDesde`/
  // `folioHasta`/`contraparteRut` de la PRIMERA limitación y descarta los de
  // la segunda. Dos limitaciones contiguas con el mismo motivo genérico de
  // `maxTramos` pero `contraparteRut` distinto fusionarían en una sola que
  // sólo menciona la primera contraparte, perdiendo la segunda — se prueba
  // directo sobre `fusionarLimitacionesContiguas` porque ningún mensaje real
  // de hoy combina un motivo idéntico con `contraparteRut` diferente (los
  // mensajes del tercer nivel embeben folio/día en el texto), pero la
  // función tiene que ser segura igual para cualquier call-site futuro.
  it('fusionarLimitacionesContiguas no fusiona limitaciones contiguas con el mismo motivo si el contraparteRut difiere', () => {
    const { scraper } = armar();
    const limitaciones: LimitacionRespaldoXml[] = [
      { fechaDesde: '2026-08-01', fechaHasta: '2026-08-01', contraparteRut: '11111111-1', motivo: 'Motivo genérico de maxTramos.' },
      { fechaDesde: '2026-08-02', fechaHasta: '2026-08-02', contraparteRut: '22222222-2', motivo: 'Motivo genérico de maxTramos.' },
    ];
    const fusionar = scraper as unknown as {
      fusionarLimitacionesContiguas(l: LimitacionRespaldoXml[]): LimitacionRespaldoXml[];
    };

    const fusionadas = fusionar.fusionarLimitacionesContiguas(limitaciones);

    expect(fusionadas).toHaveLength(2);
    expect(fusionadas[0].contraparteRut).toBe('11111111-1');
    expect(fusionadas[1].contraparteRut).toBe('22222222-2');
  });

  // `consumirPresupuesto` ya no confía SÓLO en que cada call-site chequee
  // `ctx.descargas >= maxTramos` antes de llamarla (invariante documentada
  // en `descargarListaDeGrupos`): si algún path nuevo se la saltara, esta
  // función revienta en vez de dejar pasar una llamada de más contra el
  // portal.
  it('consumirPresupuesto revienta si se lo llama con el presupuesto ya agotado', async () => {
    const { scraper } = armar();
    const consumir = scraper as unknown as {
      consumirPresupuesto(ctx: { descargas: number }, maxTramos: number): Promise<void>;
    };

    await expect(consumir.consumirPresupuesto({ descargas: 5 }, 5)).rejects.toThrow(/invariante rota/);
  });

  // Con presupuesto disponible sigue consumiendo normal: el chequeo nuevo no
  // interfiere con el camino feliz.
  it('consumirPresupuesto consume normal cuando queda presupuesto', async () => {
    const { scraper } = armar();
    const consumir = scraper as unknown as {
      consumirPresupuesto(ctx: { descargas: number }, maxTramos: number): Promise<void>;
    };
    const ctx = { descargas: 0 };

    await consumir.consumirPresupuesto(ctx, 5);

    expect(ctx.descargas).toBe(1);
  });

  // Mismo guard, con `tipoDte` distinto en vez de `contraparteRut`: dos
  // limitaciones contiguas del tercer nivel para tipos de documento
  // distintos no pueden fusionarse en una que sólo mencione el primer tipo.
  it('fusionarLimitacionesContiguas no fusiona limitaciones contiguas con el mismo motivo si el tipoDte difiere', () => {
    const { scraper } = armar();
    const limitaciones: LimitacionRespaldoXml[] = [
      { fechaDesde: '2026-08-01', fechaHasta: '2026-08-01', tipoDte: 33, motivo: 'Motivo genérico de maxTramos.' },
      { fechaDesde: '2026-08-02', fechaHasta: '2026-08-02', tipoDte: 61, motivo: 'Motivo genérico de maxTramos.' },
    ];
    const fusionar = scraper as unknown as {
      fusionarLimitacionesContiguas(l: LimitacionRespaldoXml[]): LimitacionRespaldoXml[];
    };

    const fusionadas = fusionar.fusionarLimitacionesContiguas(limitaciones);

    expect(fusionadas).toHaveLength(2);
    expect(fusionadas[0].tipoDte).toBe(33);
    expect(fusionadas[1].tipoDte).toBe(61);
  });

  // Mismo guard, con `folioDesde`/`folioHasta` distintos: dos limitaciones
  // contiguas del tercer nivel para RANGOS de folio distintos no pueden
  // fusionarse en una que sólo mencione el rango de la primera.
  it('fusionarLimitacionesContiguas no fusiona limitaciones contiguas con el mismo motivo si folioDesde/folioHasta difieren', () => {
    const { scraper } = armar();
    const limitaciones: LimitacionRespaldoXml[] = [
      {
        fechaDesde: '2026-08-01', fechaHasta: '2026-08-01', folioDesde: 1, folioHasta: 10,
        motivo: 'Motivo genérico de maxTramos.',
      },
      {
        fechaDesde: '2026-08-02', fechaHasta: '2026-08-02', folioDesde: 20, folioHasta: 30,
        motivo: 'Motivo genérico de maxTramos.',
      },
    ];
    const fusionar = scraper as unknown as {
      fusionarLimitacionesContiguas(l: LimitacionRespaldoXml[]): LimitacionRespaldoXml[];
    };

    const fusionadas = fusionar.fusionarLimitacionesContiguas(limitaciones);

    expect(fusionadas).toHaveLength(2);
    expect(fusionadas[0]).toMatchObject({ folioDesde: 1, folioHasta: 10 });
    expect(fusionadas[1]).toMatchObject({ folioDesde: 20, folioHasta: 30 });
  });

  // Mismo guard, con `razonSocial` distinto: dos limitaciones contiguas del
  // tercer nivel con razones sociales distintas no pueden fusionarse en una
  // que sólo mencione la primera.
  it('fusionarLimitacionesContiguas no fusiona limitaciones contiguas con el mismo motivo si razonSocial difiere', () => {
    const { scraper } = armar();
    const limitaciones: LimitacionRespaldoXml[] = [
      { fechaDesde: '2026-08-01', fechaHasta: '2026-08-01', razonSocial: 'Muñoz', motivo: 'Motivo genérico de maxTramos.' },
      { fechaDesde: '2026-08-02', fechaHasta: '2026-08-02', razonSocial: 'Pérez', motivo: 'Motivo genérico de maxTramos.' },
    ];
    const fusionar = scraper as unknown as {
      fusionarLimitacionesContiguas(l: LimitacionRespaldoXml[]): LimitacionRespaldoXml[];
    };

    const fusionadas = fusionar.fusionarLimitacionesContiguas(limitaciones);

    expect(fusionadas).toHaveLength(2);
    expect(fusionadas[0].razonSocial).toBe('Muñoz');
    expect(fusionadas[1].razonSocial).toBe('Pérez');
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

  // Unifica el mismo síntoma con el del historial: la descarga del respaldo
  // puede recibir la misma página de error genérica del portal, y antes de
  // este arreglo salía como el `Error` genérico de "no devolvió un SetDTE" —
  // el mismo síntoma con dos códigos distintos según por dónde entraba.
  it('la página de error genérica del portal sale como PortalSiiNoDisponible, no como el Error genérico de "no SetDTE"', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValue({
      contenido: Buffer.from(PORTAL_NO_DISPONIBLE, 'latin1'),
      contentType: 'text/html',
    });

    let error: unknown;
    try {
      await scraper.respaldoXml(RANGO);
      throw new Error('debía lanzar');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PortalSiiNoDisponible);
    expect((error as Error).message).toMatch(/04\.77\.113\.29\.408\.51/);
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

  function filaEmitido(
    folio: number, codigo: number, receptorRut = '77777777-7', tipoNombre = 'Factura Electronica'
  ): string {
    return `<tr>
      <td><a href="/cgi-bin/Portal001/mipeGesDocEmi.cgi?CODIGO=${codigo}"><img></a></td>
      <td>${receptorRut}</td>
      <td>Receptor ${receptorRut}</td>
      <td>${tipoNombre}</td>
      <td>${folio}</td>
      <td>2026-08-05</td>
      <td>1000</td>
      <td>Documento Emitido</td>
    </tr>`;
  }

  function historialEmitidosHtml(folios: number[]): string {
    return `<table>${folios.map((f, i) => filaEmitido(f, 1000 + i)).join('\n')}</table>`;
  }

  function historialEmitidosMixtoHtml(docs: { folio: number; tipoNombre?: string }[]): string {
    return `<table>${docs.map((d, i) => filaEmitido(d.folio, 1000 + i, '77777777-7', d.tipoNombre)).join('\n')}</table>`;
  }

  function filaRecibido(
    folio: number, codigo: number, emisorRut: string, tipoNombre = 'Factura Electronica'
  ): string {
    return `<tr>
      <td><a href="/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=${codigo}"><img></a></td>
      <td>${emisorRut}</td>
      <td>Emisor ${emisorRut}</td>
      <td>${tipoNombre}</td>
      <td>${folio}</td>
      <td>2026-08-05</td>
      <td>1000</td>
      <td>Documento Recibido</td>
    </tr>`;
  }

  function historialRecibidosHtml(docs: { folio: number; emisorRut: string; tipoNombre?: string }[]): string {
    return `<table>${docs.map((d, i) => filaRecibido(d.folio, 2000 + i, d.emisorRut, d.tipoNombre)).join('\n')}</table>`;
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
      // Cada grupo devuelve documentos DENTRO de su propio rango (tipo 33,
      // igual que `DIA`): con folios y tipo a medida, el filtro de
      // `descargarGrupoConBiseccion` no descarta nada y `documentos` cuenta
      // lo esperado.
      .mockResolvedValueOnce(binarioXmlConFolios(33, [1, 2]))
      .mockResolvedValueOnce(binarioXmlConFolios(33, [21, 22]))
      .mockResolvedValueOnce(binarioXmlConFolios(33, [41, 42]));

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(3);
    expect(r.documentos).toBe(6); // 2 documentos × 3 grupos, ya filtrados por folio+tipo

    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(4);
    expect(llamadas[1][1]).toMatchObject({ FOLIO: '1', FOLIOHASTA: '20' });
    expect(llamadas[2][1]).toMatchObject({ FOLIO: '21', FOLIOHASTA: '40' });
    expect(llamadas[3][1]).toMatchObject({ FOLIO: '41', FOLIOHASTA: '45' });
  });

  // BLOQUEANTE de la ronda 11: con el flag prendido y un CGI que ignorara
  // `FOLIO` (el riesgo no verificado del flag), TODA descarga de folio único
  // seguiría excediendo el tope. Sin el tope de `TOPE_FOLIOS_UNICOS_POR_DIA`,
  // 45 folios producirían hasta 24 limitaciones casi idénticas y 47 llamadas;
  // con el tope, se corta bien antes: como mucho `TOPE_FOLIOS_UNICOS_POR_DIA`
  // limitaciones individuales más un puñado de colapsos con rango envolvente
  // (no necesariamente UNA sola: el colapso corta por CADA bisección o grupo
  // en curso cuando el contador ya venía alto, así que puede salir más de
  // una, pero siempre acotado y lejos de las 24 originales).
  it('emitidos: con TODA descarga excediendo el tope, las limitaciones de folio único se acotan', async () => {
    const { scraper, http } = armar();
    const folios = Array.from({ length: 45 }, (_, i) => i + 1);
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock).mockResolvedValue(binarioDemasiados());

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, maxTramos: 48 });

    expect(r.tramos).toEqual([]);
    // Muy por debajo de las 24 que saldrían sin el tope.
    expect(r.limitaciones.length).toBeLessThanOrEqual(15);
    const individuales = r.limitaciones.filter(l => l.folioDesde === l.folioHasta);
    expect(individuales.length).toBeLessThanOrEqual(10);
    const colapsadas = r.limitaciones.filter(l => l.motivo.includes('TIPO_DTE_NOMBRES') === false
      && l.folioDesde !== l.folioHasta);
    expect(colapsadas.length).toBeGreaterThan(0);
    for (const l of colapsadas) expect(l.motivo).toMatch(/rango envolvente de los pendientes/);
    // Muy por debajo de las 47 llamadas que saldrían sin el tope.
    expect((http.getBinario as jest.Mock).mock.calls.length).toBeLessThanOrEqual(25);
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

  // El bug real: el listado del tercer nivel (`listarEmitidosDelDia`) puede
  // recibir la misma página de error transitorio que el historial normal.
  // Antes de este arreglo, `parseHistorial` la leía como "cero filas" y
  // `trocearPorEjeFino` la reportaba como "el listado no devolvió ningún
  // folio" — la limitación de un dato genuinamente vacío, no la de un portal
  // que no contestó. El fallo tiene que PROPAGARSE tal cual (no convertirse en
  // limitación) para que el consumidor sepa que hay que reintentar, no que
  // ese día está vacío.
  it('emitidos: si el listado del tercer nivel devuelve la página de error del portal, el fallo se propaga sin convertirse en "no devolvió ningún folio"', async () => {
    const { scraper, http } = armar();
    mockearListado(http, PORTAL_NO_DISPONIBLE);
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    let error: unknown;
    try {
      await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA });
      throw new Error('debía lanzar');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PortalSiiNoDisponible);
    expect((error as Error).message).not.toMatch(/no devolvió ningún folio/);
  });

  // Espejo RCP del test anterior: `listarRecibidosDelDia` puede recibir la
  // misma página, y antes de este arreglo terminaba en "el listado no
  // devolvió ningún emisor" en vez de propagar el fallo transitorio.
  it('recibidos: si el listado del tercer nivel devuelve la página de error del portal, el fallo se propaga sin convertirse en "no devolvió ningún emisor"', async () => {
    const { scraper, http } = armar();
    mockearListado(http, PORTAL_NO_DISPONIBLE);
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    let error: unknown;
    try {
      await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });
      throw new Error('debía lanzar');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PortalSiiNoDisponible);
    expect((error as Error).message).not.toMatch(/no devolvió ningún emisor/);
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

  // El presupuesto puede agotarse a mitad de la BISECCIÓN de un emisor y
  // ANTES de llegar al siguiente: dos limitaciones distintas, no una — la del
  // primer emisor con los folios que le quedaron pendientes (colapsados por
  // `descargarGrupoConBiseccion`), y la de "emisores sin procesar" nombrando al
  // segundo, que ni se intentó.
  it('recibidos: presupuesto agotado a mitad de la bisección del primer emisor deja DOS limitaciones', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 10, emisorRut: '11111111-1' },
      { folio: 11, emisorRut: '11111111-1' },
      { folio: 12, emisorRut: '11111111-1' },
      { folio: 1, emisorRut: '22222222-2' },
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero (descargas: 1)
      .mockResolvedValueOnce(binarioDemasiados()) // emisor 11111111, plano (descargas: 3, tras el listado)
      .mockResolvedValueOnce(binarioDemasiados()); // grupo [10,11,12] (descargas: 4 — se agota acá)

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA, maxTramos: 4 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(2);
    // La primera: los folios del emisor 11111111 que quedaron sin bajar,
    // colapsados en un solo rango (10..12).
    expect(r.limitaciones[0]).toMatchObject({
      contraparteRut: '11111111-1', folioDesde: 10, folioHasta: 12, tipoDte: 33,
    });
    // La segunda: el emisor 22222222 ni se intentó, nombrado en el motivo.
    expect(r.limitaciones[1].contraparteRut).toBeUndefined();
    expect(r.limitaciones[1].motivo).toMatch(/22222222-2/);
    expect(http.getBinario).toHaveBeenCalledTimes(3);
  });

  // Un emisor con MÁS de 20 folios en el día tiene que agruparse de a lo sumo
  // `TOPE_DOCUMENTOS_SII` (igual que ENV) antes de intentar la descarga: pasar
  // los 45 folios de una sola vez excede seguro y quema una llamada condenada
  // a fallar. Con la heurística de la ronda 4, el listado por sí solo (45 >
  // TOPE) ya alcanza para saltarse la descarga "plana" del emisor entero: va
  // directo a grupos sin gastar esa llamada condenada.
  it('recibidos: un emisor con 45 folios se agrupa de a 20 directo, sin la descarga plana', async () => {
    const { scraper, http } = armar();
    const docs = Array.from({ length: 45 }, (_, i) => ({ folio: i + 1, emisorRut: '11111111-1' }));
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValue(binarioXml());           // cada grupo de a lo sumo 20 folios

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(3);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(4); // día entero + 3 grupos (sin la plana)
    expect(llamadas[1][1]).toMatchObject({ FOLIO: '1', FOLIOHASTA: '20' });
    expect(llamadas[2][1]).toMatchObject({ FOLIO: '21', FOLIOHASTA: '40' });
    expect(llamadas[3][1]).toMatchObject({ FOLIO: '41', FOLIOHASTA: '45' });
  });

  // Con EXACTAMENTE `TOPE_DOCUMENTOS_SII` folios la heurística NO se dispara
  // (`>`, no `>=`): la plana SÍ cabe si los conteos coinciden, así que se
  // intenta primero — es la llamada más barata (sin combinar folio con
  // tipo_dte) y, si funciona, ahorra el agrupamiento entero.
  it('recibidos: un emisor con EXACTAMENTE 20 folios intenta la plana primero (cabe si los conteos coinciden)', async () => {
    const { scraper, http } = armar();
    const docs = Array.from({ length: 20 }, (_, i) => ({ folio: i + 1, emisorRut: '11111111-1' }));
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioXml());       // la plana del emisor, cabe

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(2); // día entero + la plana, sin agrupar por folio
    expect(llamadas[1][1]).toMatchObject({ RUT_RECP: '11111111', FOLIO: '' });
  });

  // Si la plana de EXACTAMENTE 20 folios SÍ excede (conteos no coinciden
  // entre listado y descarga), el `if` de abajo la manda a agrupar — una
  // llamada de más que el caso feliz, el mismo costo que ya paga cualquier
  // grupo que se biseccione de más.
  it('recibidos: un emisor con EXACTAMENTE 20 folios, si la plana excede, cae a agrupar por folio', async () => {
    const { scraper, http } = armar();
    const docs = Array.from({ length: 20 }, (_, i) => ({ folio: i + 1, emisorRut: '11111111-1' }));
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioDemasiados()) // la plana, excede igual
      .mockResolvedValueOnce(binarioXml());       // el grupo de folios

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas).toHaveLength(3); // día entero + plana (falla) + grupo
    expect(llamadas[2][1]).toMatchObject({ FOLIO: '1', FOLIOHASTA: '20' });
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
    // Los dos grupos (1..20 y 21..25) tienen que colapsar en UNA sola
    // limitación con el rango completo, igual que el caso de recibidos "a
    // mitad de la bisección" — si el colapso de hermanos regresionara,
    // volverían 2 limitaciones (una por grupo) en vez de 1.
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({
      fechaDesde: '2026-08-05', fechaHasta: '2026-08-05', tipoDte: 33, folioDesde: 1, folioHasta: 25,
    });
    expect(r.limitaciones[0].motivo).toMatch(/tramos/i);
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

  // Tope EXPLÍCITO de páginas (distinto del de `maxTramos`): un día
  // anormalmente grande no se resuelve subiendo `maxTramos` —seguiría
  // leyendo página tras página del mismo día enorme—, así que corta antes,
  // con un `maxTramos` alto de sobra para que quede claro que NO es el
  // presupuesto lo que se agotó.
  it('emitidos: tope explícito de páginas del listado, distinto de maxTramos agotado', async () => {
    const { scraper, http } = armar();
    // Cada página "dice" que hay 15 en total (el máximo NUM_PAG que aparece);
    // con el tope de páginas en 10, el loop corta ANTES de llegar a la 15.
    const paginaConQuinceEnTotal =
      '<table></table>'
      + '<div class="paginacion">'
      + '<a href="/cgi-bin/Portal001/mipeAdminDocsEmi.cgi?NUM_PAG=15">15</a>'
      + '</div>';
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockResolvedValue(paginaConQuinceEnTotal);
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, maxTramos: 20 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/más de 10 páginas/);
    expect(r.limitaciones[0].motivo).not.toMatch(/mitad de camino/);
    // parseEmpresas, auth.cgi, y sólo 10 páginas del listado (no 15, ni las
    // que el presupuesto de 20 hubiera permitido).
    expect(http.get).toHaveBeenCalledTimes(2 + 10);
  });

  // Borde de `TOPE_PAGINAS_LISTADO`: el loop corta con `pagina >
  // TOPE_PAGINAS_LISTADO`, así que la página 10 (el tope mismo) tiene que
  // LEERSE, no cortar — nada más lo fijaba antes de este test.
  it('emitidos: exactamente 10 páginas del listado se leen completas, sin el tope explícito', async () => {
    const { scraper, http } = armar();
    const paginaConDiezEnTotal = (folio: number) =>
      historialEmitidosHtml([folio])
      + '<div class="paginacion">'
      + '<a href="/cgi-bin/Portal001/mipeAdminDocsEmi.cgi?NUM_PAG=10">10</a>'
      + '</div>';
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>');
    for (let pagina = 1; pagina <= 10; pagina++) {
      (http.get as jest.Mock).mockResolvedValueOnce(paginaConDiezEnTotal(pagina));
    }
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioXml());       // el grupo de 10 folios, cabe

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, maxTramos: 20 });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
    // parseEmpresas, auth.cgi, y las 10 páginas del listado enteras — el tope
    // explícito NO se dispara con exactamente 10.
    expect(http.get).toHaveBeenCalledTimes(2 + 10);
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
    // El motivo tiene que nombrar CUÁLES emisores quedaron pendientes: sin
    // esto, "acotá con contraparte_rut" es una sugerencia a ciegas.
    expect(r.limitaciones[0].motivo).toMatch(/22222222-2/);
    expect(r.limitaciones[0].motivo).toMatch(/acotá con contraparte_rut/);
    // Sin contraparte_rut fijado por el caller, el campo estructurado va
    // ausente (nada que repetir).
    expect(r.limitaciones[0].contraparteRut).toBeUndefined();
  });

  // BLOQUEANTE de la ronda 11: la limitación de "emisores sin procesar"
  // perdía el `contraparteRut` del caller, aunque los otros dos caminos del
  // mismo `trocearPorEjeFino` (`descargarListaDeGrupos`/
  // `descargarGrupoConBiseccion`) ya lo conservaban con el mismo fallback
  // `overrideBase.contraparteRut ?? ctx.filtros.contraparteRut`. Además, si
  // el caller YA fijó `contraparte_rut`, sugerir "acotá con contraparte_rut"
  // es un no-op que confunde.
  it('recibidos: con contraparte_rut fijado, "emisores sin procesar" lo conserva y NO repite la sugerencia', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 1, emisorRut: '11111111-1' },
      { folio: 2, emisorRut: '22222222-2' },
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero (1er tramo)
      .mockResolvedValueOnce(binarioXml());       // emisor 11111111 (2º tramo)

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'RCP', ...DIA, maxTramos: 3, contraparteRut: '11111111-1',
    });

    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].contraparteRut).toBe('11111111-1');
    expect(r.limitaciones[0].motivo).not.toMatch(/acotá con contraparte_rut/);
    expect(r.limitaciones[0].motivo).toMatch(/maxTramos más alto/);
  });

  // Espejo RCP del tope explícito de páginas del listado.
  it('recibidos: tope explícito de páginas del listado, distinto de maxTramos agotado', async () => {
    const { scraper, http } = armar();
    const paginaConQuinceEnTotal =
      '<table></table>'
      + '<div class="paginacion">'
      + '<a href="/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?NUM_PAG=15">15</a>'
      + '</div>';
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockResolvedValue(paginaConQuinceEnTotal);
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA, maxTramos: 20 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/más de 10 páginas/);
    expect(r.limitaciones[0].motivo).not.toMatch(/mitad de camino/);
    expect(http.get).toHaveBeenCalledTimes(2 + 10);
  });

  // Con más de 10 emisores pendientes, el motivo trunca la lista (los
  // primeros 10) y resume el resto — nombrar los 40 RUT pendientes sería tan
  // ilegible como no nombrar ninguno.
  it('recibidos: más de 10 emisores pendientes trunca la lista y resume el resto', async () => {
    const { scraper, http } = armar();
    const docs = Array.from({ length: 12 }, (_, i) => ({
      folio: i + 1, emisorRut: `1000000${String(i).padStart(2, '0')}-${i % 10}`,
    }));
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero (1er tramo)
      .mockResolvedValueOnce(binarioXml());       // el primer emisor (2º tramo)

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA, maxTramos: 3 });

    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/quedaron 11 emisores sin procesar/);
    expect(r.limitaciones[0].motivo).toMatch(/y 1 más/);
  });

  // Si el caller YA pidió un folio único (folio_desde === folio_hasta, o sólo
  // folio_desde), el intento que acaba de exceder el tope en `acumularTramos`
  // usó ese MISMO filtro (fecha+tipo+folio). Listar el día y volver a pedir
  // exactamente ese folio son dos llamadas cuyo resultado ya se conoce.
  it('emitidos: folio único ya pedido por el caller corta directo a la limitación, sin listar', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero, con el folio único

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, folioDesde: 5, folioHasta: 5 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ folioDesde: 5, folioHasta: 5, tipoDte: 33 });
    expect(r.limitaciones[0].motivo).toMatch(/folio 5/);
    // Nunca se llega a listar: sólo parseEmpresas + auth.cgi.
    expect(http.get).toHaveBeenCalledTimes(2);
    expect(http.getBinario).toHaveBeenCalledTimes(1);
  });

  it('emitidos: un solo folio_desde (sin folio_hasta) también corta directo, sin listar', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados());

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, folioDesde: 7 });

    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ folioDesde: 7, folioHasta: 7 });
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  // Espejo RCP del atajo de folio único: hoy hacía listado + descarga plana +
  // grupo de un folio (3 llamadas) antes de llegar a la misma limitación que
  // ENV corta en cero. El filtro (fecha+tipo+folio, con o sin contraparte) ya
  // se sabe condenado, así que no hay nada que listar ni bisectar.
  it('recibidos: folio único ya pedido por el caller corta directo a la limitación, sin listar', async () => {
    const { scraper, http } = armar();
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero, con el folio único

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA, folioDesde: 5, folioHasta: 5 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ folioDesde: 5, folioHasta: 5, tipoDte: 33 });
    expect(r.limitaciones[0].motivo).toMatch(/folio 5/);
    // Nunca se llega a listar: sólo parseEmpresas + auth.cgi.
    expect(http.get).toHaveBeenCalledTimes(2);
    expect(http.getBinario).toHaveBeenCalledTimes(1);
  });

  // Si el caller ya fijó `contraparteRut`, el listado sólo trae ESE emisor y
  // la descarga "plana" repetiría fecha+tipo+contraparte exactos — la misma
  // llamada que acaba de exceder en `acumularTramos`. Se salta directo a
  // grupos de folios, sin gastar esa llamada condenada.
  it('recibidos: contraparte_rut ya fijado por el caller salta la descarga plana, va directo a grupos', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 1, emisorRut: '77777777-7' },
      { folio: 2, emisorRut: '77777777-7' },
      { folio: 3, emisorRut: '77777777-7' },
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioXml());       // grupo [1,2,3] directo, sin la plana

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'RCP', ...DIA, contraparteRut: '77777777-7',
    });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
    // Sólo 2 llamadas: el día entero + el grupo. Sin la plana, que hubiera
    // repetido fecha+tipo+contraparte y fallado igual que el intento original.
    expect(http.getBinario).toHaveBeenCalledTimes(2);
  });

  // Cuando `maxTramos` se agota A MITAD de la bisección, los grupos hermanos
  // que quedan pendientes (varios niveles de la partición, no sólo uno) tienen
  // que colapsarse en UNA sola limitación con el rango combinado — no una por
  // hoja pendiente, que sería ruidoso y redundante para el mismo motivo.
  it('emitidos: maxTramos agotado a mitad de la bisección colapsa los hermanos restantes en UNA limitación', async () => {
    const { scraper, http } = armar();
    const folios = [1, 2, 3, 4, 5, 6, 7, 8];
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero (descargas: 1)
      .mockResolvedValueOnce(binarioDemasiados()) // grupo [1..8] (descargas: 3, tras el listado)
      .mockResolvedValueOnce(binarioDemasiados()); // grupo [1,2,3,4] (descargas: 4 — se agota acá)

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, maxTramos: 4 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ folioDesde: 1, folioHasta: 8, tipoDte: 33 });
    expect(r.limitaciones[0].motivo).toMatch(/tramos/i);
    expect(http.getBinario).toHaveBeenCalledTimes(3);
  });

  // El override con el que ENV arma la bisección es `{}` (nunca lleva
  // `contraparte_rut`, que del lado ENV vive sólo en `ctx.filtros`): sin el
  // fallback a `ctx.filtros.contraparteRut`, la limitación de presupuesto
  // agotado saldría sin ese campo aunque el caller lo haya fijado, rompiendo
  // la promesa de que `limitaciones` trae EXACTAMENTE el filtro a repetir.
  it('emitidos: la limitación de presupuesto agotado incluye contraparte_rut cuando el caller lo fijó', async () => {
    const { scraper, http } = armar();
    const folios = [1, 2, 3, 4, 5, 6, 7, 8];
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioDemasiados()) // grupo [1..8]
      .mockResolvedValueOnce(binarioDemasiados()); // grupo [1,2,3,4]

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', ...DIA, maxTramos: 4, contraparteRut: '77777777-7',
    });

    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].contraparteRut).toBe('77777777-7');
    expect(r.limitaciones[0]).toMatchObject({ folioDesde: 1, folioHasta: 8, tipoDte: 33 });
  });

  // Con el presupuesto agotado ENTRE dos grupos de folios (no dentro de la
  // bisección de UNO, que ya cubre el test de arriba), cada grupo restante
  // entraba igual a `descargarGrupoConBiseccion`, veía el presupuesto agotado y
  // empujaba su propia limitación — acá habría sido `21..40` y después
  // `41..45` en vez de una sola `21..45`.
  it('emitidos: maxTramos agotado ENTRE grupos de folios colapsa el resto en UNA sola limitación', async () => {
    const { scraper, http } = armar();
    const folios = Array.from({ length: 45 }, (_, i) => i + 1);
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero (descargas: 1)
      .mockResolvedValueOnce(binarioXml());       // grupo [1..20] (descargas: 3, tras el listado)

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA, maxTramos: 3 });

    expect(r.tramos).toHaveLength(1);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ folioDesde: 21, folioHasta: 45, tipoDte: 33 });
    expect(r.limitaciones[0].motivo).toMatch(/tramos/i);
    expect(http.getBinario).toHaveBeenCalledTimes(2);
  });

  // `contraparte_rut` (el receptor, del lado emitidos) del caller original
  // tiene que seguir viajando en CADA grupo de folios del tercer nivel, no
  // sólo en el intento inicial: si se perdiera al agrupar, el primer grupo
  // vendría filtrado por contraparte y el resto no.
  it('emitidos: conserva contraparte_rut (receptor) del caller en cada grupo de folios', async () => {
    const { scraper, http } = armar();
    const folios = Array.from({ length: 25 }, (_, i) => i + 1);
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValue(binarioXml());           // cada grupo

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', ...DIA, contraparteRut: '77777777-7',
    });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(2);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    expect(llamadas.length).toBeGreaterThan(1);
    for (const [, params] of llamadas) {
      expect(params).toMatchObject({ RUT_RECP: '77777777' });
    }
  });

  // Folios NO contiguos (huecos por anulados, u otro tipo si el CGI no
  // respetara `TPO_DOC`): `descargarGrupoConBiseccion` pide por los EXTREMOS
  // del grupo discreto (folio 1..1000), que es económico en llamadas, pero
  // el SII puede devolver un folio intermedio (250) que el listado del día+
  // tipo NUNCA mostró. Sin filtrar por el grupo pedido, ese documento ajeno
  // se cuenta en `documentos` y queda en el XML devuelto.
  // Con folios no contiguos (huecos por anulados, u otra razón), el grupo
  // completo se pide igual por RANGO —FOLIO=1..FOLIOHASTA=1000, lo económico
  // en llamadas— y el SII puede devolver un folio intermedio (250) que el
  // listado del día+tipo no mostró. Eso NO se filtra ni se descarta: es un
  // documento real de la misma empresa y el mismo día, así que respaldarlo es
  // respaldo de MÁS, nunca de menos, y no hay over-conteo porque `enGrupos`
  // parte una lista ordenada en rangos disjuntos por construcción. El XML
  // firmado se guarda tal como lo entrega el SII —reescribirlo para sacar el
  // folio 250 le costaría la `Caratula`/`Signature` del envío completo, que
  // no son parte de ningún `<DTE>` individual, y sería fácil identificar mal
  // el folio de una nota de crédito (que trae otro `<Folio>` dentro de
  // `<Referencia>`)—.
  it('emitidos: folios no contiguos pueden traer documentos vecinos del mismo día, y se guardan tal cual', async () => {
    const { scraper, http } = armar();
    const folios = [1, 500, 1000]; // el listado: sólo estos tres folios del día+tipo
    mockearListado(http, historialEmitidosHtml(folios));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero, sin folio
      // El grupo completo [1,500,1000] se pide como FOLIO=1..FOLIOHASTA=1000;
      // el SII devuelve esos tres MÁS un cuarto (folio 250) que el listado
      // nunca mostró — el hueco que el rango expone y la lista discreta no.
      .mockResolvedValueOnce(binarioXmlConFolios(33, [1, 250, 500, 1000]));

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
    // El folio 250 SIGUE en el respaldo y CUENTA: no se reescribe el XML
    // firmado para sacarlo.
    expect(r.documentos).toBe(4);
    expect(r.tramos[0].xml).toContain('ID="S250"');
    expect(r.tramos[0].xml).toContain('ID="S1"');
    expect(r.tramos[0].xml).toContain('ID="S500"');
    expect(r.tramos[0].xml).toContain('ID="S1000"');
  });

  // `contraparte_rut` es "con o sin DV" para quien llama, pero el listado del
  // portal —igual que la descarga en `descargarTramo`— sólo matchea el CUERPO
  // sin guión. Si el filtro crudo llegara con DV al listado, el CGI no
  // encontraría coincidencias, el listado volvería vacío y
  // `trocearPorEjeFino` terminaría en la limitación silenciosa "el listado no
  // devolvió ningún folio" sin haber bajado nada. Acá el mock del listado SÍ
  // mira el parámetro de RUT (a diferencia de `mockearListado`, que lo
  // ignora) para que este test falle si la normalización se pierde.
  it('emitidos: contraparte_rut llega al listado sin DV, igual que a la descarga', async () => {
    const { scraper, http } = armar();
    const folios = Array.from({ length: 25 }, (_, i) => i + 1);
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockImplementationOnce((_url: string, params?: Record<string, string>) => {
        expect(params?.RUT_RECP).toBe('77777777');
        return Promise.resolve(historialEmitidosHtml(folios));
      });
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValue(binarioXml());           // cada grupo de folios

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', ...DIA, contraparteRut: '77777777-7',
    });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos.length).toBeGreaterThan(0);
  });

  // Espejo RCP del test anterior: el listado de recibidos filtra por EMISOR
  // (`RUT_EMI`), no por receptor, pero el mismo bug era posible ahí (el RUT
  // crudo con DV no matchea nada). Con `contraparte_rut` ya fijado, el atajo
  // de la ronda 4 salta la descarga plana, así que sólo hay día entero + 1
  // grupo de folios en `getBinario`.
  it('recibidos: contraparte_rut llega al listado sin DV, igual que a la descarga', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 1, emisorRut: '77777777-7' },
      { folio: 2, emisorRut: '77777777-7' },
    ];
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockImplementationOnce((_url: string, params?: Record<string, string>) => {
        expect(params?.RUT_EMI).toBe('77777777');
        return Promise.resolve(historialRecibidosHtml(docs));
      });
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValue(binarioXml());           // el grupo, directo por el atajo de contraparte fijada

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'RCP', ...DIA, contraparteRut: '77777777-7',
    });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos.length).toBeGreaterThan(0);
  });

  // BLOQUEANTE de la ronda 10: `params`/`paramsRecibidos` mandaban
  // `RZN_SOC: ''` hardcodeado sin importar el filtro, así que un pedido con
  // `razon_social` filtraba en `descargarTramo` (el intento inicial) pero NO
  // en este listado del tercer nivel: el listado devolvía los folios de TODAS
  // las contrapartes del día, ensanchando el rango envolvente que arma
  // `trocearPorEjeFino` de más.
  it('emitidos: razon_social llega al listado, no sólo a la descarga', async () => {
    const { scraper, http } = armar();
    const folios = Array.from({ length: 25 }, (_, i) => i + 1);
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockImplementationOnce((_url: string, params?: Record<string, string>) => {
        expect(params?.RZN_SOC).toBe('Muñoz');
        return Promise.resolve(historialEmitidosHtml(folios));
      });
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValue(binarioXml());           // cada grupo de folios

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', ...DIA, razonSocial: 'Muñoz',
    });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos.length).toBeGreaterThan(0);
  });

  // Espejo RCP: mismo bug era posible ahí, con la misma consecuencia agravada
  // —una descarga por CADA emisor del día, no sólo los que matchean
  // `razon_social`, el barrido de llamadas inútiles que el flag del tercer
  // nivel existe para evitar—.
  it('recibidos: razon_social llega al listado, no sólo a la descarga', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 1, emisorRut: '77777777-7' },
      { folio: 2, emisorRut: '88888888-8' },
    ];
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockImplementationOnce((_url: string, params?: Record<string, string>) => {
        expect(params?.RZN_SOC).toBe('Muñoz');
        return Promise.resolve(historialRecibidosHtml(docs));
      });
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValue(binarioXml());           // cada emisor

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'RCP', ...DIA, razonSocial: 'Muñoz',
    });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos.length).toBeGreaterThan(0);
  });

  // Defensivo: `parseHistorialRecibidos` resuelve `tipoDte` con
  // `TIPO_DTE_NOMBRES[nombre] ?? 0`, y nada filtraba por `ctx.filtros.tipoDte`
  // antes de agrupar por emisor. Un documento de OTRO tipo mezclado en el
  // listado (si el CGI no respetara `TPO_DOC`) se colaba en el grupo de
  // folios del emisor, ensuchando el rango pedido con un folio ajeno.
  it('recibidos: documentos de otro tipo en el listado no contaminan el agrupado por folio', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 10, emisorRut: '11111111-1', tipoNombre: 'Factura Electronica' },        // tipo 33, el de DIA
      { folio: 99, emisorRut: '11111111-1', tipoNombre: 'Nota de Credito Electronica' }, // tipo 61, ajeno
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero
      .mockResolvedValueOnce(binarioDemasiados()) // emisor 11111111, plano — excede, fuerza agrupar por folio
      .mockResolvedValueOnce(binarioXmlConFolios(33, [10])); // el grupo, ya sin el folio ajeno

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
    expect(r.documentos).toBe(1);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    // Sin el filtro por tipo, el grupo sería [10,99] y este llamado pediría
    // FOLIO=10..FOLIOHASTA=99 en vez de sólo el folio 10.
    expect(llamadas[2][1]).toMatchObject({ FOLIO: '10', FOLIOHASTA: '10' });
  });

  // Espejo del test anterior, del lado ENV: `parseHistorial` resuelve
  // `tipoDte` igual que `parseHistorialRecibidos`, y nada filtraba por
  // `ctx.filtros.tipoDte` antes de agrupar por folio. Un documento de OTRO
  // tipo mezclado en el listado (folio 5000, tipo 61) se colaba en el grupo
  // de folios del día y ensuchaba el rango pedido con un folio ajeno —tipo
  // 33 (folios 10, 11) más tipo 61 (folio 5000) agruparía `[10, 11, 5000]` y
  // pediría `FOLIO=10..5000`, un rango 500× más ancho que nunca converge.
  it('emitidos: documentos de otro tipo en el listado no contaminan el agrupado por folio', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 10, tipoNombre: 'Factura Electronica' },        // tipo 33, el de DIA
      { folio: 11, tipoNombre: 'Factura Electronica' },        // tipo 33, el de DIA
      { folio: 5000, tipoNombre: 'Nota de Credito Electronica' }, // tipo 61, ajeno
    ];
    mockearListado(http, historialEmitidosMixtoHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero, sin folio
      .mockResolvedValueOnce(binarioXmlConFolios(33, [10, 11])); // el grupo, ya sin el folio ajeno

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
    expect(r.documentos).toBe(2);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    // Sin el filtro por tipo, el grupo sería [10,11,5000] y este llamado
    // pediría FOLIO=10..FOLIOHASTA=5000 en vez de 10..11.
    expect(llamadas[1][1]).toMatchObject({ FOLIO: '10', FOLIOHASTA: '11' });
  });

  // Criterio corregido (ronda 9): sólo se descarta un tipo MAPEADO que no
  // coincide, no lo que `TIPO_DTE_NOMBRES` no supo mapear (`tipoDte` cae en
  // `0`). Una variante de nombre ausente del mapa NO puede perder folios
  // reales: se piden igual, junto con los del tipo pedido.
  it('emitidos: una variante de nombre no mapeada por TIPO_DTE_NOMBRES no se descarta, se pide igual', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 10, tipoNombre: 'Factura Electronica' },      // tipo 33, el de DIA
      { folio: 999, tipoNombre: 'Variante Rara Sin Mapear' }, // TIPO_DTE_NOMBRES no la tiene: tipoDte 0
    ];
    mockearListado(http, historialEmitidosMixtoHtml(docs));
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el día entero, sin folio
      .mockResolvedValueOnce(binarioXmlConFolios(33, [10, 999])); // el grupo, con AMBOS folios

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'ENV', ...DIA });

    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(1);
    expect(r.documentos).toBe(2);
    const llamadas = (http.getBinario as jest.Mock).mock.calls;
    // El folio 999 (sin mapear) SIGUE en el grupo pedido: si se descartara
    // como el tipo ajeno (5000 del test anterior), este rango sería 10..10.
    expect(llamadas[1][1]).toMatchObject({ FOLIO: '10', FOLIOHASTA: '999' });
  });

  // Con TODOS los documentos sin mapear (el bug real que motivó el criterio:
  // una variante de nombre ausente hace que `folios` termine vacío después de
  // acotar por `folio_desde`/`folio_hasta`), la limitación de "no devolvió
  // ningún folio" tiene que avisar que `TIPO_DTE_NOMBRES` puede ser la causa,
  // no sólo culpar al portal.
  it('emitidos: con folios sin mapear presentes, el motivo de "sin folios" nombra TIPO_DTE_NOMBRES', async () => {
    const { scraper, http } = armar();
    // El único documento del día es de una variante no mapeada (tipoDte 0,
    // pasa el filtro), pero su folio (500) queda FUERA del rango de folio que
    // pide el caller (1..10): `acotarPorFolio` lo saca y `folios` da vacío.
    const docs = [{ folio: 500, tipoNombre: 'Variante Rara Sin Mapear' }];
    mockearListado(http, historialEmitidosMixtoHtml(docs));
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', ...DIA, folioDesde: 1, folioHasta: 10,
    });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/TIPO_DTE_NOMBRES/);
  });

  // Espejo del caso ENV equivalente: si el listado de recibidos no trae NINGÚN
  // emisor, la limitación tiene que llevar el `folio_desde`/`folio_hasta` del
  // caller igual que del lado emitido — es el mismo filtro exacto que no se
  // pudo trocear más fino.
  // Espejo RCP de la nota `TIPO_DTE_NOMBRES`, en el motivo de "quedaron N
  // emisores sin procesar" (presupuesto agotado ENTRE emisores). El OTRO
  // motivo RCP con la misma nota —"el listado no devolvió ningún emisor"—
  // no se puede alcanzar con `sinMapear > 0`: un documento sin mapear
  // (`tipoDte === 0`) siempre PASA el filtro y entra a `foliosPorEmisor`
  // (ver el criterio de la ronda 9), así que ese Map nunca puede quedar
  // vacío si hay al menos un documento sin mapear en el listado.
  it('recibidos: con folios sin mapear presentes, "quedaron N emisores sin procesar" nombra TIPO_DTE_NOMBRES', async () => {
    const { scraper, http } = armar();
    const docs = [
      { folio: 1, emisorRut: '11111111-1', tipoNombre: 'Factura Electronica' },       // tipo 33, el de DIA
      { folio: 2, emisorRut: '11111111-1', tipoNombre: 'Variante Rara Sin Mapear' },  // tipoDte 0
    ];
    mockearListado(http, historialRecibidosHtml(docs));
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    const r = await scraper.respaldoXml({ ...RANGO, origen: 'RCP', ...DIA, maxTramos: 2 });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0].motivo).toMatch(/TIPO_DTE_NOMBRES/);
  });

  it('recibidos: sin emisores en el listado, la limitación lleva folio_desde/folio_hasta del caller', async () => {
    const { scraper, http } = armar();
    mockearListado(http, historialRecibidosHtml([]));
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'RCP', ...DIA, folioDesde: 10, folioHasta: 20,
    });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ folioDesde: 10, folioHasta: 20, tipoDte: 33 });
  });

  // `contraparte_rut` es parte del filtro exacto que hay que repetir para
  // volver a pedir este sub-rango, aunque el camino de "sin emisores en el
  // listado" no lo haya usado para nada (el listado ya viene filtrado por
  // `receptorRut`/`emisorRut` antes de llegar acá): sin este campo, el
  // consumidor perdería la contraparte al reintentar.
  it('recibidos: sin emisores en el listado y con contraparte_rut fijado, la limitación lo incluye', async () => {
    const { scraper, http } = armar();
    mockearListado(http, historialRecibidosHtml([]));
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'RCP', ...DIA, contraparteRut: '11111111-1',
    });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ tipoDte: 33, contraparteRut: '11111111-1' });
  });

  // Espejo del lado ENV: si el listado no devuelve ningún folio y el caller
  // fijó `contraparte_rut` (el receptor), tiene que quedar en la limitación
  // igual que del lado recibido.
  it('emitidos: sin folios en el listado y con contraparte_rut fijado, la limitación lo incluye', async () => {
    const { scraper, http } = armar();
    mockearListado(http, historialEmitidosHtml([]));
    (http.getBinario as jest.Mock).mockResolvedValueOnce(binarioDemasiados()); // el día entero

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', ...DIA, contraparteRut: '77777777-7',
    });

    expect(r.tramos).toEqual([]);
    expect(r.limitaciones).toHaveLength(1);
    expect(r.limitaciones[0]).toMatchObject({ tipoDte: 33, contraparteRut: '77777777-7' });
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

  // El flag es de ARRANQUE: se lee UNA sola vez al entrar a `respaldoXml`, no
  // en cada chequeo dentro del loop de bisección. Con dos días llenos en el
  // mismo pedido, se prende el flag, se lo apaga A MITAD del primer día (justo
  // después de su listado), y el SEGUNDO día tiene que seguir tratándolo como
  // prendido: si se releyera `process.env` en cada chequeo, el segundo día
  // saldría con la limitación de "tercer nivel desactivado" en vez de trocear.
  it('el flag se lee una sola vez: un cambio de env a mitad de la request no la dejas mitad y mitad', async () => {
    process.env.RESPALDO_XML_TERCER_NIVEL = '1';
    const { scraper, http } = armar();
    const filaDia = (dia: string, folio: number, codigo: number) => `<tr>
      <td><a href="/cgi-bin/Portal001/mipeGesDocEmi.cgi?CODIGO=${codigo}"><img></a></td>
      <td>77777777-7</td>
      <td>Receptor</td>
      <td>Factura Electronica</td>
      <td>${folio}</td>
      <td>${dia}</td>
      <td>1000</td>
      <td>Documento Emitido</td>
    </tr>`;
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce('<html></html>')
      .mockImplementationOnce(() => {
        // Se apaga ACÁ, justo tras el listado del PRIMER día: si el flag se
        // releyera por chequeo, el segundo día ya lo vería apagado.
        process.env.RESPALDO_XML_TERCER_NIVEL = '0';
        return Promise.resolve(`<table>${filaDia('2026-08-05', 1, 9200)}</table>`);
      })
      .mockResolvedValueOnce(`<table>${filaDia('2026-08-06', 2, 9201)}</table>`);
    (http.getBinario as jest.Mock)
      .mockResolvedValueOnce(binarioDemasiados()) // el rango completo (2 días), excede
      .mockResolvedValueOnce(binarioDemasiados()) // día 1 solo, excede -> tercer nivel
      .mockResolvedValueOnce(binarioXml())        // día 1: grupo de folios
      .mockResolvedValueOnce(binarioDemasiados()) // día 2 solo, excede -> tercer nivel
      .mockResolvedValueOnce(binarioXml());       // día 2: grupo de folios

    const r = await scraper.respaldoXml({
      ...RANGO, origen: 'ENV', fechaDesde: '2026-08-05', fechaHasta: '2026-08-06', tipoDte: 33,
    });

    // Si el flag se hubiera releído, el día 2 saldría con la limitación de
    // "tercer nivel desactivado" en vez de un tramo bajado.
    expect(r.limitaciones).toEqual([]);
    expect(r.tramos).toHaveLength(2);
  });
});

// `soloCuerpoRut` quedó exportada como API pública (la usan tanto el scraper
// como `verificarRespaldoXml.ts`) sin tener un test propio: se prueba acá,
// aparte del comportamiento de `respaldoXml` que la ejercita indirectamente.
describe('soloCuerpoRut', () => {
  it('con DV pegado, devuelve sólo el cuerpo', () => {
    expect(soloCuerpoRut('77777777-7')).toBe('77777777');
  });

  it('sin DV, lo deja tal cual', () => {
    expect(soloCuerpoRut('77777777')).toBe('77777777');
  });

  it('con puntos y DV, limpia los puntos y saca el DV', () => {
    expect(soloCuerpoRut('77.777.777-7')).toBe('77777777');
  });
});

// `acotarPorFolio` quedó exportada por testeabilidad (se usa dentro de
// `trocearPorEjeFino` para acotar el listado del día+tipo al rango de folio
// del llamador) sin tener un test propio.
describe('acotarPorFolio', () => {
  it('sin folioDesde ni folioHasta, deja pasar todo', () => {
    expect(acotarPorFolio([1, 5, 10], {} as any)).toEqual([1, 5, 10]);
  });

  it('con folioDesde y folioHasta, recorta a ambos lados', () => {
    expect(acotarPorFolio([1, 5, 10, 15, 20], { folioDesde: 5, folioHasta: 15 } as any)).toEqual([5, 10, 15]);
  });

  // Borde explícito del brief: `folioDesde` puesto SIN `folioHasta` — el
  // fallback (`filtros.folioHasta ?? filtros.folioDesde`) colapsa el techo al
  // mismo `folioDesde`, igual que un folio único (mismo criterio que
  // `limitacionFolioUnico` usa para reconocer "folio exacto, sin rango").
  it('con folioDesde y sin folioHasta, el techo colapsa al mismo folioDesde (folio exacto)', () => {
    expect(acotarPorFolio([1, 5, 10, 15], { folioDesde: 10 } as any)).toEqual([10]);
  });

  // Sin `folioDesde`, la función corta camino y devuelve todo sin filtrar —
  // `folioHasta` solo no alcanza para acotar nada (mismo `if` de guarda).
  it('con folioHasta y sin folioDesde, no filtra nada (folioDesde es el que gatilla el recorte)', () => {
    expect(acotarPorFolio([1, 5, 10, 15], { folioHasta: 10 } as any)).toEqual([1, 5, 10, 15]);
  });
});

// `enGrupos` quedó exportada por testeabilidad (parte una lista ORDENADA en
// rangos disjuntos de a lo sumo `tamano`, la base de por qué ningún documento
// puede caer en dos grupos) sin tener un test propio.
describe('enGrupos', () => {
  it('parte en grupos de a lo sumo `tamano`, el último con el resto', () => {
    expect(enGrupos([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('con menos elementos que `tamano`, un solo grupo', () => {
    expect(enGrupos([1, 2, 3], 20)).toEqual([[1, 2, 3]]);
  });

  it('lista vacía, ningún grupo', () => {
    expect(enGrupos([], 20)).toEqual([]);
  });
});
