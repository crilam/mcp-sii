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

    expect(r.casilleros).toContainEqual({ codigo: '520', valor: '100000' });
    // La tasa es el caso que rompe cualquier conversión a entero, así que se
    // afirma directo y no dentro de un `if`: un assert condicionado a que el
    // fixture tenga el código no prueba nada el día que el fixture cambia.
    expect(r.casilleros).toContainEqual({ codigo: '115', valor: '0.125' });
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

  // Este test vale acá y NO en la ruta: el fixture es la respuesta REAL del SII,
  // con `resultadoCalculoPP29.traza` (que lleva el RUT) y `listCodBase` (razón
  // social y domicilio) adentro. En la ruta, con el core mockeado, un test así
  // pasa por construcción aunque el código filtre.
  it('no arrastra la traza ni la identificación del contribuyente al resultado', async () => {
    const { scraper } = conRespuestas(PROPUESTA);

    const r = await scraper.propuesta('202607');

    // El fixture SÍ los trae: si no, el test no probaría nada.
    const crudo = JSON.stringify(PROPUESTA);
    expect(crudo).toContain('resultadoCalculoPP29');
    expect(crudo).toContain('listCodBase');

    const salida = JSON.stringify(r);
    expect(salida).not.toContain('traza');
    expect(salida).not.toContain('resultadoCalculoPP29');
    expect(salida).not.toContain('listCodBase');
    expect(salida).not.toContain('EMPRESA DE PRUEBA');
  });

  // Un fallo del SII NO puede leerse como "no hay propuesta": el consumidor
  // recibiría "no reintentar" ante algo que sí se arregla reintentando.
  it('un 200 con errors del SII lanza, no se disfraza de período sin propuesta', async () => {
    const { scraper, http } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({
      data: null,
      metaData: { errors: [{ id: '0', descripcion: 'Request.MetaData.Namespace deberia ser ...' }] },
    });

    await expect(scraper.propuesta('202607')).rejects.toThrow(/rechazó la consulta/i);
  });

  it('data ausente lanza, y tampoco se confunde con sin propuesta', async () => {
    const { scraper, http } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({ metaData: {} });

    await expect(scraper.propuesta('202607')).rejects.toThrow(/no devolvió datos/i);
  });

  // Sin propuesta no hay nada que fechar: preguntarlo sería una segunda llamada
  // al SII por un dato que el consumidor no va a usar.
  it('sin propuesta no hace la segunda consulta', async () => {
    const { scraper, http } = armar();
    (http.postSdi as jest.Mock).mockResolvedValueOnce({ data: { ...PROPUESTA, listCodPropuestos: [] } });

    const r = await scraper.propuesta('202608');

    expect(r.casilleros).toBeNull();
    expect(http.postSdi).toHaveBeenCalledTimes(1);
  });

  // `errors: []` es truthy: sin mirar el contenido, toda consulta exitosa que
  // trajera la lista vacía habría lanzado.
  it('una lista de errors VACÍA no es un error', async () => {
    const { scraper, http } = armar();
    (http.postSdi as jest.Mock)
      .mockResolvedValueOnce({ data: PROPUESTA, metaData: { errors: [] } })
      .mockResolvedValueOnce({ data: [] });

    const r = await scraper.propuesta('202607');

    expect(r.casilleros).not.toBeNull();
  });

  // El SII puede mandar la lista como null en vez de como []. Las dos formas
  // significan lo mismo y ninguna es un error.
  it('listCodPropuestos null también es un período sin propuesta', async () => {
    const { scraper } = conRespuestas({ ...PROPUESTA, listCodPropuestos: null });

    const r = await scraper.propuesta('202608');

    expect(r.casilleros).toBeNull();
  });


  // Con rectificatorias el período tiene más de una declaración. Se busca la
  // VIGENTE explícitamente: confiar en que el SII la ordene primero es una
  // convención del portal que nadie garantiza. El orden acá está invertido a
  // propósito, para que un `filas[0]` falle.
  it('con varias declaraciones toma la VIGENTE, no la primera', async () => {
    const { scraper } = conRespuestas(PROPUESTA, [
      { estado: 'Rectificada', declFechaCreacion: '01/08/2026 09:00:00' },
      { estado: 'Vigente', declFechaCreacion: '10/08/2026 10:28:02' },
    ]);

    const r = await scraper.propuesta('202607');

    expect(r.fechaCreacion).toBe('10/08/2026 10:28:02');
  });

  // El caso que rompe un `/vigente/i` sin anclar: "No Vigente" CONTIENE la
  // palabra, así que un find ingenuo se queda con la declaración reemplazada y
  // devuelve su fecha como si fuera la del período.
  it('"No Vigente" no cuenta como vigente, aunque contenga la palabra', async () => {
    const { scraper } = conRespuestas(PROPUESTA, [
      { estado: 'No Vigente', declFechaCreacion: '01/01/2026 09:00:00' },
      { estado: 'Vigente', declFechaCreacion: '01/01/2026 12:00:00' },
    ]);

    const r = await scraper.propuesta('202607');

    expect(r.fechaCreacion).toBe('01/01/2026 12:00:00');
  });

  // Sólo la vigente cuenta, haya una o varias: el consumidor no recibe el estado,
  // así que la fecha de una anulada sería indistinguible de la de una declaración
  // buena.
  it('una sola declaración anulada tampoco da fecha', async () => {
    const { scraper } = conRespuestas(PROPUESTA, [
      { estado: 'Anulada', declFechaCreacion: '01/01/2026 09:00:00' },
    ]);

    const r = await scraper.propuesta('202607');

    expect(r.fechaCreacion).toBeNull();
  });

  // Con varias y ninguna vigente no se adivina: devolver la fecha de una anulada
  // como si fuera la del período es peor que no devolver nada.
  it('con varias declaraciones y ninguna vigente devuelve null', async () => {
    const { scraper } = conRespuestas(PROPUESTA, [
      { estado: 'Anulada', declFechaCreacion: '01/01/2026 09:00:00' },
      { estado: 'No Vigente', declFechaCreacion: '01/01/2026 10:00:00' },
    ]);

    const r = await scraper.propuesta('202607');

    expect(r.fechaCreacion).toBeNull();
  });

  // El mensaje del error va a `console.error`: el texto del SII es libre y puede
  // traer datos del contribuyente.
  it('acota el texto de error del SII antes de ponerlo en el mensaje', async () => {
    const { scraper, http } = armar();
    (http.postSdi as jest.Mock).mockResolvedValue({
      data: null,
      metaData: { errors: [{ descripcion: 'x'.repeat(500) }] },
    });

    await expect(scraper.propuesta('202607')).rejects.toThrow(/x{200}(?!x)/);
  });

  // Mismo modo de fallo que el de la propuesta, pero en la SEGUNDA consulta: sin
  // validar, un error del SII dejaba la fecha en null y el consumidor lo leía
  // como "el período no está declarado".
  it('un error del SII en la consulta del estado lanza, no queda como sin declarar', async () => {
    const { scraper, http } = armar();
    (http.postSdi as jest.Mock)
      .mockResolvedValueOnce({ data: PROPUESTA })
      .mockResolvedValueOnce({ data: null, metaData: { errors: [{ descripcion: 'sesión caída' }] } });

    await expect(scraper.propuesta('202607')).rejects.toThrow(/estado de la declaración/i);
  });

  it('un data no-array en la consulta del estado deja la fecha en null sin romper', async () => {
    const { scraper } = conRespuestas(PROPUESTA, { algo: 'que no es lista' });

    const r = await scraper.propuesta('202607');

    expect(r.fechaCreacion).toBeNull();
    expect(r.casilleros).not.toBeNull();
  });
});
