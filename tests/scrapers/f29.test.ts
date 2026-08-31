import { sobreGetFolios, F29Scraper } from '../../src/scrapers/f29';
import { codificarLong } from '../../src/scrapers/gwtRpc';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { RecursoNoEncontrado } from '../../src/erroresConsulta';

jest.mock('../../src/http');
jest.mock('../../src/session');

// Respuesta REAL de getFoliosConsulta para un período declarado (ids
// anonimizados salvo folio/codInt, que no son datos personales).
const OK = `//OK[-7,-7,4,24,23,22,-7,'xdp',5,21,20,'tcaQa',5,'xdp',5,'C5Z20',5,19,0,18,'Hc1lAB',5,17,'A',5,0,-6,16,15,14,1,3,13,12,11,10,9,8,0,7,'WFX5y',5,6,'Eh_hw',5,4,2026,3,2,1,1,["java.util.Vector/3057315478","cl.sii.sdi.sifm.commons.to.consulta.FolioPeriodoFormularioTO/3253336399","java.lang.Integer/3438268394","2","java.lang.Long/4227064769","SINOBS","DRCP","Vigente","AMBOS","29","F29 - Declaración Mensual","Declaración Mensual","MES","DPS","G1515000gym","MPD_PLANT","20/02/2026","800000001","CLP","2026-02-20 22:45:21.0","N","OPVPHHA","M01","CRCIVA"],0,7]`;
// Un período SIN declaración: el Vector viene vacío, sin folio ni codInt.
const OK_VACIO = '//OK[1,1,["java.util.Vector/3057315478"],0,7]';

describe('sobreGetFolios', () => {
  // El RUT y el período viajan como longs GWT inline; el sobre se rompe si se
  // codifican mal. Se comprueba contra los valores medidos en vivo.
  it('codifica el RUT y el período como los espera GWT', () => {
    const sobre = sobreGetFolios(76019824, 202601, 'SANTIAGO ORIENTE');

    expect(sobre).toContain(`|${codificarLong(202601)}|${codificarLong(76019824)}|`);
    expect(sobre).toContain('Eh_hw');   // 76019824
    expect(sobre).toContain('|76019824|18|76019824|'); // el RUT literal, dos veces
    expect(sobre).toContain('SANTIAGO ORIENTE');
  });

  // La unidad va en la tabla de strings: un `|` la partiría en dos y correría
  // todos los índices, rompiendo el sobre.
  it('saca los pipes de la unidad operativa', () => {
    expect(sobreGetFolios(1, 202601, 'A|B')).toContain('|A B|');
  });
});

describe('F29Scraper', () => {
  function armar(gwt: string) {
    const session = new (SessionManager as jest.MockedClass<typeof SessionManager>)({} as any, {} as any);
    const http = new (SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>)(session);
    (session.assertPuedeEntregarCookieJar as jest.Mock) = jest.fn();
    (session.identidad as jest.Mock) = jest.fn(() => ({ rut: '76019824', dv: '2' }));
    (http.postCrudo as jest.Mock) = jest.fn().mockResolvedValue(gwt);
    return { scraper: new F29Scraper(http, session), http, session };
  }

  it('lee folio, codInt y estado de un período declarado', async () => {
    const { scraper } = armar(OK);

    const e = await scraper.estadoDeclaracion(202601, 'SANTIAGO ORIENTE');

    expect(e).toMatchObject({
      periodo: 202601, formulario: '29', folio: 8000000001, codInt: '800000001',
      estado: 'Vigente', observaciones: 'SINOBS', fechaPresentacion: '20/02/2026', moneda: 'CLP',
    });
  });

  it('manda el sobre GWT con el content-type y la permutación', async () => {
    const { scraper, http } = armar(OK);

    await scraper.estadoDeclaracion(202601);

    const [url, cuerpo, contentType, headers] = (http.postCrudo as jest.Mock).mock.calls[0];
    expect(url).toContain('svcConsulta');
    expect(cuerpo).toContain('getFoliosConsulta');
    expect(contentType).toMatch(/x-gwt-rpc/);
    expect(headers['X-GWT-Permutation']).toBeTruthy();
  });

  // Un período sin declaración vigente no es un error del scraper: es un dato.
  it('un período sin declaración es NO_ENCONTRADO', async () => {
    const { scraper } = armar(OK_VACIO);

    await expect(scraper.estadoDeclaracion(203001)).rejects.toBeInstanceOf(RecursoNoEncontrado);
  });

  // Un período con rectificatoria trae dos declaraciones. El folio y su codInt
  // se leen ADYACENTES para no cruzarlos: el par correcto es folio 8000000001 +
  // codInt 800000001, aunque haya OTRO folio 8000000002 después en el stream.
  it('con dos declaraciones toma folio y codInt de la misma (no los cruza)', async () => {
    // tabla: 1=Vector 2=TO 3=codInt1 4=Vigente 5=29 6=fecha 7=codInt2 8=CLP 9=SINOBS
    // stream resuelto: [codInt1, folio1(Hc1lAB), Vigente, codInt2, folio2(Hc1lAC), fecha, SINOBS, CLP]
    const dos = "//OK[3,'Hc1lAB',4,7,'Hc1lAC',6,9,8,[\"java.util.Vector/3057315478\",\"cl.sii.sdi.sifm.commons.to.consulta.FolioPeriodoFormularioTO/3253336399\",\"800000001\",\"Vigente\",\"29\",\"20/02/2026\",\"800000002\",\"CLP\",\"SINOBS\"],0,7]";
    const { scraper } = armar(dos);

    const e = await scraper.estadoDeclaracion(202601);

    expect(e.folio).toBe(8000000001);
    expect(e.codInt).toBe('800000001'); // el pegado al folio, no 800000002
  });

  // El sobre mal formado devuelve //EX: no puede leerse como "sin declaración".
  it('una excepción GWT no se confunde con período sin datos', async () => {
    const { scraper } = armar('//EX[2,1,["com.google.gwt.user.client.rpc.IncompatibleRemoteServiceException/3936916533"],0,7]');

    await expect(scraper.estadoDeclaracion(202601)).rejects.toThrow(/excepción/);
  });

  it('el PDF exige el codInt y valida el Content-Type', async () => {
    const { scraper, session } = armar(OK);
    const http = new (SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>)(session);
    (http.getBinario as jest.Mock) = jest.fn().mockResolvedValue({ contenido: Buffer.from('%PDF-1.4 x'), contentType: 'application/pdf' });
    const s2 = new F29Scraper(http, session);

    await expect(s2.pdfCompacto(8000000001, '800000001')).resolves.toEqual(Buffer.from('%PDF-1.4 x'));
    expect(http.getBinario).toHaveBeenCalledWith(expect.stringContaining('formCompacto'),
      expect.objectContaining({ folio: '8000000001', codInt: '800000001', form: '029', rut: '76019824' }));
  });

  it('si el PDF no viene con Content-Type de PDF, falla explícito', async () => {
    const { session } = armar(OK);
    const http = new (SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>)(session);
    (session.assertPuedeEntregarCookieJar as jest.Mock) = jest.fn();
    (session.identidad as jest.Mock) = jest.fn(() => ({ rut: '76019824', dv: '2' }));
    (http.getBinario as jest.Mock) = jest.fn().mockResolvedValue({ contenido: Buffer.from('<html>error</html>'), contentType: 'text/html' });

    await expect(new F29Scraper(http, session).pdfCompacto(1, 'x')).rejects.toThrow(/no devolvió un PDF/);
  });
});
