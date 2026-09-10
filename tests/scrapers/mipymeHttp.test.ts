import * as fs from 'fs';
import * as path from 'path';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { SelectorEmpresasVacio, EmpresaNoAutorizada, PortalSiiNoDisponible } from '../../src/erroresConsulta';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', nombre), 'utf-8');
}

const SEL_EMPRESA = fixture('mipyme-sel-empresa.html');
const HISTORIAL = fixture('mipyme-historial-emitidos.html');
const SIN_EMPRESA = fixture('mipyme-sin-empresa.html');
const PORTAL_NO_DISPONIBLE = fixture('mipyme-portal-no-disponible.html');

function armar() {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.conEmpresaExclusiva as jest.Mock) = jest.fn((fn: () => Promise<unknown>) => fn());
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {});
  const scraper = new MipymeHttpScraper(http, session);
  return { scraper, http, session };
}

describe('MipymeHttpScraper.listEmpresas', () => {
  it('parsea el combo de mipeSelEmpresa.cgi: RUT con DV y nombre sin el RUT repetido', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    const empresas = await scraper.listEmpresas();

    // Las cuatro, no dos: el SII no cierra los <option> y un parser que consuma
    // el "<" del siguiente devuelve una de cada dos, sin error. Pasó de verdad
    // contra el portal real (5 empresas en el combo, 3 devueltas).
    expect(empresas).toEqual([
      { rut: '22222222-2', nombre: 'EMPRESA DOS SPA' },
      { rut: '33333333-3', nombre: 'COMERCIAL TRES LTDA' },
      { rut: '44444444-4', nombre: 'SERVICIOS CUATRO SPA' },
      { rut: '55555555-5', nombre: 'TRANSPORTES CINCO SPA' },
    ]);
  });

  it('no navega: una sola consulta GET al CGI de selección', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    await scraper.listEmpresas();

    expect(http.get).toHaveBeenCalledTimes(1);
    expect((http.get as jest.Mock).mock.calls[0][0]).toContain('mipeSelEmpresa.cgi');
  });

  // Un combo vacío significa que el CGI no devolvió la página esperada (sesión
  // caída, rediseño, WAF) O que el RUT autenticado no opera ninguna empresa en
  // el portal —un permiso a nivel de PERSONA, no de empresa, verificado contra
  // el portal real (ver el comentario de SelectorEmpresasVacio en
  // erroresConsulta.ts)—. La ambigüedad de PARSEO no se resuelve (por eso NO
  // se devuelve `[]`, que la volvería indistinguible de "esta empresa no tiene
  // documentos" más adelante), pero el fallo ya no viaja como Error pelado: el
  // adaptador REST lo traduce a `EMPRESA_NO_AUTORIZADA` con `detalle`, en vez
  // de `ERROR` mudo.
  it('falla si no hay ninguna opción en el combo, en vez de devolver lista vacía', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue('<html><body>sesión expirada</body></html>');

    await expect(scraper.listEmpresas()).rejects.toThrow(SelectorEmpresasVacio);
    await expect(scraper.listEmpresas()).rejects.toThrow(/no devolvió ninguna empresa/i);
  });
});

describe('MipymeHttpScraper.listDteEmitidos', () => {
  it('selecciona la empresa por POST antes de consultar el historial', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(http.postForm).toHaveBeenCalledWith(
      expect.stringContaining('mipeSelEmpresa.cgi'),
      { RUT_EMP: '33333333-3' }
    );
    // El POST tiene que ocurrir ANTES del GET del historial: sin selección, el
    // CGI responde el error de "no ha seleccionado una Empresa".
    const ordenGet = (http.get as jest.Mock).mock.invocationCallOrder;
    const ordenPost = (http.postForm as jest.Mock).mock.invocationCallOrder[0];
    expect(ordenPost).toBeGreaterThan(ordenGet[0]);
    expect(ordenPost).toBeLessThan(ordenGet[1]);
  });

  it('parsea las 8 columnas pese al <td> sin cerrar del RUT del receptor', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.documentos).toHaveLength(2);
    // Si el parser exigiera </td>, receptorRut traería la razón social y todo
    // lo demás estaría corrido un lugar. Este assert es el que fija el bug.
    expect(res.documentos[0]).toEqual({
      receptorRut: '33333333-3',
      receptorNombre: 'COMERCIAL TRES LTDA',
      tipoDte: 33,
      tipoDteNombre: 'Factura Electronica',
      folio: 244,
      fecha: '2026-07-08',
      monto: 24783,
      estado: 'Documento Emitido',
      codigo: '987654',
    });
    expect(res.documentos[1].tipoDte).toBe(61);
    expect(res.documentos[1].folio).toBe(12);
    expect(res.documentos[1].monto).toBe(119000);
  });

  it('conserva el CODIGO del link, que identifica el documento y no se puede derivar del folio', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.documentos.map(d => d.codigo)).toEqual(['987654', '987655']);
  });

  it('reporta el error propio del CGI cuando falta la selección de empresa', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(SIN_EMPRESA);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    await expect(scraper.listDteEmitidos({ empresaRut: '33333333-3' }))
      .rejects.toThrow(/no ha seleccionado una empresa/i);
  });

  // El bug medido contra el SII real: `mipeAdminDocsRcp.cgi` devolvió su propia
  // página de error interno («Error al contribuyente» / «no se puede responder
  // a sus requerimientos») para una empresa de alto volumen, y el parser —que
  // sólo sabe leer filas `<tr>`— no encontró ninguna fila de datos ahí adentro
  // y lo leyó como "cero documentos". Un fallo transitorio del portal
  // reportado como un historial vacío es peor que un error: el consumidor
  // concluye que esta empresa no emitió nada, cuando en realidad el SII no
  // llegó a contestar. Tiene que fallar con `PortalSiiNoDisponible`, con el
  // código del SII en el mensaje, y NO devolver `{documentos: []}`.
  it('falla con PortalSiiNoDisponible si el portal devuelve su página de error interno, en vez de "cero documentos"', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(PORTAL_NO_DISPONIBLE);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    let error: unknown;
    try {
      await scraper.listDteEmitidos({ empresaRut: '33333333-3' });
      throw new Error('debía lanzar');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PortalSiiNoDisponible);
    expect((error as Error).message).toMatch(/04\.77\.113\.29\.408\.51/);
  });

  // El marcado de la página de error NO es contrato del SII: puede cambiar sin
  // aviso (una palabra envuelta en un tag, una entidad en vez de un espacio, la
  // frase partida en varias líneas) sin que el AVISO en sí cambie. Los tres
  // casos de acá deforman la MISMA página real de la misma manera en que un
  // volcado a mano —o un rediseño futuro del portal— podría hacerlo, y los
  // tres tienen que seguir disparando.
  describe('la detección de la página de error sobrevive a deformaciones del marcado', () => {
    async function esperarPortalSiiNoDisponible(html: string): Promise<Error> {
      const { scraper, http } = armar();
      (http.get as jest.Mock)
        .mockResolvedValueOnce(SEL_EMPRESA)
        .mockResolvedValueOnce(html);
      (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

      let error: unknown;
      try {
        await scraper.listDteEmitidos({ empresaRut: '33333333-3' });
        throw new Error('debía lanzar');
      } catch (e) {
        error = e;
      }
      return error as Error;
    }

    it('con un tag partiendo la frase del título ("Error al <b>contribuyente</b>")', async () => {
      const html = `<html><head><title>Error al <b>contribuyente</b></title></head><body>
        <script>alert('Por el momento no se puede responder a sus requerimientos. ` +
        `CODIGO: 04.77.113.29.408.51');</script></body></html>`;

      const error = await esperarPortalSiiNoDisponible(html);

      expect(error).toBeInstanceOf(PortalSiiNoDisponible);
      expect(error.message).toMatch(/04\.77\.113\.29\.408\.51/);
    });

    it('con &nbsp; en vez de espacio entre palabras', async () => {
      const html = `<html><head><title>Error&nbsp;al&nbsp;contribuyente</title></head><body>
        <script>alert('Por&nbsp;el&nbsp;momento no&nbsp;se puede responder a sus ` +
        `requerimientos.&nbsp;CODIGO:&nbsp;04.77.113.29.408.51');</script></body></html>`;

      const error = await esperarPortalSiiNoDisponible(html);

      expect(error).toBeInstanceOf(PortalSiiNoDisponible);
      expect(error.message).toMatch(/04\.77\.113\.29\.408\.51/);
    });

    it('con la frase repartida en varias líneas y con sangría', async () => {
      const html = `<html><head><title>Error al contribuyente</title></head><body>
        <script>alert('Por el momento no se puede responder
            a sus
        requerimientos. Por favor, inténtelo más tarde.

        CODIGO: 04.77.113.29.408.51');</script></body></html>`;

      const error = await esperarPortalSiiNoDisponible(html);

      expect(error).toBeInstanceOf(PortalSiiNoDisponible);
      expect(error.message).toMatch(/04\.77\.113\.29\.408\.51/);
    });
  });

  // Negativo: normalizar el HTML antes de buscar las frases AMPLÍA lo que
  // puede matchear (ya no hace falta que la frase sea un substring literal del
  // HTML crudo), así que la exigencia de las DOS frases —no una sola— importa
  // más todavía para no convertir una consulta legítima en un fallo.
  describe('la detección no confunde datos legítimos con la página de error', () => {
    it('el historial real (fixture HISTORIAL) no dispara PortalSiiNoDisponible', async () => {
      const { scraper, http } = armar();
      (http.get as jest.Mock)
        .mockResolvedValueOnce(SEL_EMPRESA)
        .mockResolvedValueOnce(HISTORIAL);
      (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

      await expect(scraper.listDteEmitidos({ empresaRut: '33333333-3' })).resolves.toBeDefined();
    });

    // Una razón social de fantasía ("ERROR AL CONTRIBUYENTE SPA") no es
    // descabellada, y el título de la página de error real tampoco es un texto
    // tan raro como para asumir que nunca va a aparecer en un dato de verdad.
    // Sin la SEGUNDA frase, que es la que de verdad sólo trae la página de
    // error, esto no puede disparar.
    it('una razón social que dice literalmente "Error al contribuyente" no dispara sola, sin la segunda frase', async () => {
      const { scraper, http } = armar();
      const conRazonSocialRara = HISTORIAL.replace(
        'COMERCIAL TRES LTDA', 'ERROR AL CONTRIBUYENTE SPA'
      );
      (http.get as jest.Mock)
        .mockResolvedValueOnce(SEL_EMPRESA)
        .mockResolvedValueOnce(conRazonSocialRara);
      (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

      const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

      expect(res.documentos.some(d => d.receptorNombre === 'ERROR AL CONTRIBUYENTE SPA')).toBe(true);
    });
  });

  // El caso "selector no vacío, pero la empresa pedida no está entre las
  // suyas": el RUT autenticado opera OTRAS empresas, no la pedida — mismo
  // permiso a nivel de persona que SelectorEmpresasVacio, pero acá SÍ se sabe
  // que el CGI respondió bien (no hay ambigüedad de sesión caída/WAF), así que
  // se distingue con su propio tipo, EmpresaNoAutorizada.
  it('exige que la empresa pedida esté en el combo, en vez de consultar otra', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    await expect(scraper.listDteEmitidos({ empresaRut: '99999999-9' }))
      .rejects.toThrow(EmpresaNoAutorizada);
    await expect(scraper.listDteEmitidos({ empresaRut: '99999999-9' }))
      .rejects.toThrow(/99999999-9/);
    expect(http.postForm).not.toHaveBeenCalled();
  });

  // El detalle NO debe listar los RUT de las otras empresas: son datos de
  // terceros desde el punto de vista de quien preguntó por una empresa
  // puntual. Sí es útil el CONTEO — la fixture SEL_EMPRESA trae 4 empresas.
  it('el mensaje de empresa no autorizada cuenta las otras empresas sin listar sus RUT', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    await expect(scraper.listDteEmitidos({ empresaRut: '99999999-9' }))
      .rejects.toThrow(/4 empresas distintas/);
    // Ninguno de los RUT de la fixture (que no sea el pedido) puede aparecer.
    try {
      await scraper.listDteEmitidos({ empresaRut: '99999999-9' });
      throw new Error('debía lanzar');
    } catch (e) {
      const mensaje = (e as Error).message;
      for (const rut of ['22222222-2', '33333333-3', '44444444-4', '55555555-5']) {
        expect(mensaje).not.toContain(rut);
      }
    }
  });

  it('manda los filtros al CGI con el formato que espera, y fechas dd/mm/aaaa', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    await scraper.listDteEmitidos({
      empresaRut: '33333333-3',
      tipoDte: 33,
      fechaDesde: '2026-07-01',
      fechaHasta: '2026-07-31',
      receptorRut: '44444444-4',
      folio: 244,
      pagina: 2,
    });

    const [, params] = (http.get as jest.Mock).mock.calls[1];
    expect(params).toMatchObject({
      TPO_DOC: '33',
      FEC_DESDE: '01/07/2026',
      FEC_HASTA: '31/07/2026',
      RUT_RECP: '44444444-4',
      FOLIO: '244',
      NUM_PAG: '2',
    });
  });

  // El servicio pagina de a 100 filas y no informa el total: pedir la página 4
  // de un historial de 3 devuelve vacío, que es indistinguible de "no hay
  // documentos" si no se dice qué se pidió.
  it('informa la página consultada junto con los documentos', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.pagina).toBe(1);
  });

  it('rechaza pagina menor a 1 antes de consultar', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    await expect(scraper.listDteEmitidos({ empresaRut: '33333333-3', pagina: 0 }))
      .rejects.toThrow(/pagina/i);
    expect(http.get).not.toHaveBeenCalled();
  });

  // El punto de diseño central de la migración: la empresa activa es estado del
  // servidor, así que dos consultas con empresas distintas se pisan igual sin
  // navegador. Si alguien saca el envoltorio, este test cae.
  it('serializa el ciclo completo con conEmpresaExclusiva', async () => {
    const { scraper, http, session } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(session.conEmpresaExclusiva).toHaveBeenCalledTimes(1);
  });

  it('informa cuántas páginas hay, que el HTML sí trae', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.totalPaginas).toBe(3);
  });

  // Un parser que no rinde no puede devolver una lista vacía: 100 documentos con
  // el parser roto se leerían como "esta empresa no emitió nada". Es el mismo
  // vacío ambiguo que el proyecto cierra en el RCV y en Consultas DTE.
  it('falla si hay filas de datos que el parser no pudo interpretar', async () => {
    const { scraper, http } = armar();
    // Fila con las 8 celdas y su link, pero sin el parámetro CODIGO: es una fila
    // de datos legítima que el parser no sabe representar.
    const roto = HISTORIAL.replace('?ALL_PAGE_ANT=1&CODIGO=987654', '?ALL_PAGE_ANT=1&OTRO=987654');
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(roto);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    await expect(scraper.listDteEmitidos({ empresaRut: '33333333-3' }))
      .rejects.toThrow(/no pudo interpretar/i);
  });

  it('no confunde la fila de encabezado con una fila que falló', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.documentos).toHaveLength(2);
  });

  // Un historial legítimamente vacío no puede confundirse con un parser roto:
  // sin filas de datos no hay nada que interpretar, y la lista vacía es correcta.
  it('devuelve lista vacía sin fallar cuando el historial no tiene filas', async () => {
    const { scraper, http } = armar();
    const vacio = '<html><body><table><tr><th>Ver</th><th>Receptor</th></tr></table>' +
      '<div>P&aacute;gina 1&nbsp;de 1&nbsp;</div></body></html>';
    (http.get as jest.Mock)
      .mockResolvedValueOnce(SEL_EMPRESA)
      .mockResolvedValueOnce(vacio);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({ empresaRut: '33333333-3' });

    expect(res.documentos).toEqual([]);
  });

  it('con varias empresas y sin empresa_rut, falla dando las dos salidas', async () => {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);

    await expect(scraper.listDteEmitidos({}))
      .rejects.toThrow(/empresa_rut.*SII_EMPRESA_RUT/s);
    expect(http.postForm).not.toHaveBeenCalled();
  });

  // Contrato que tenía el camino de navegador y que la migración conserva: con
  // una sola empresa no hay nada que elegir.
  it('con una sola empresa la resuelve sola, sin exigir empresa_rut', async () => {
    const { scraper, http } = armar();
    const unaSola = SEL_EMPRESA
      .replace(/<option value="33333333-3">[^\n]*\n/, '')
      .replace(/<option value="44444444-4">[^\n]*\n/, '')
      .replace(/<option value="55555555-5">[^\n]*\n/, '');
    (http.get as jest.Mock)
      .mockResolvedValueOnce(unaSola)
      .mockResolvedValueOnce(HISTORIAL);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');

    const res = await scraper.listDteEmitidos({});

    expect(res.empresaRut).toBe('22222222-2');
    expect(http.postForm).toHaveBeenCalledWith(expect.any(String), { RUT_EMP: '22222222-2' });
  });
});

// El camino HTTP necesita el cookie jar, que sólo produce la autenticación con
// certificado. Es un CAMBIO respecto del camino de navegador, que funcionaba con
// clave tributaria: hay que fallar antes de tocar la red y con el mensaje que
// explica qué configurar, no con un "sesión expirada" más adelante.
describe('MipymeHttpScraper: requiere certificado digital', () => {
  it('listEmpresas falla sin consultar cuando la sesión no puede dar el cookie jar', async () => {
    const { scraper, http, session } = armar();
    (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {
      throw new Error('requieren autenticación con certificado digital');
    });

    await expect(scraper.listEmpresas()).rejects.toThrow(/certificado digital/i);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('listDteEmitidos falla sin consultar por la misma razón', async () => {
    const { scraper, http, session } = armar();
    (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {
      throw new Error('requieren autenticación con certificado digital');
    });

    await expect(scraper.listDteEmitidos({ empresaRut: '33333333-3' }))
      .rejects.toThrow(/certificado digital/i);
    expect(http.get).not.toHaveBeenCalled();
    expect(http.postForm).not.toHaveBeenCalled();
  });
});
