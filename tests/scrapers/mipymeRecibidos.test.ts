import * as fs from 'fs';
import * as path from 'path';
import { MipymeHttpScraper } from '../../src/scrapers/mipymeHttp';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', nombre), 'utf-8');
}

const SEL_EMPRESA = fixture('mipyme-sel-empresa.html');
const RECIBIDOS = fixture('mipyme-historial-recibidos.html');
const SIN_EMPRESA = fixture('mipyme-sin-empresa.html');

function armar() {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.conEmpresaExclusiva as jest.Mock) = jest.fn((fn: () => Promise<unknown>) => fn());
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {});
  const scraper = new MipymeHttpScraper(http, session);
  return { scraper, http, session };
}

function conHistorial(html: string = RECIBIDOS) {
  const { scraper, http, session } = armar();
  (http.get as jest.Mock)
    .mockResolvedValueOnce(SEL_EMPRESA)
    .mockResolvedValueOnce(html);
  (http.postForm as jest.Mock).mockResolvedValue('<html></html>');
  return { scraper, http, session };
}

describe('MipymeHttpScraper.listDteRecibidos', () => {
  // El CGI de recibidos NO se adivinó: el menú lleva a mipeLaunchPage.cgi, que
  // asigna el destino por JavaScript. Es `...Rcp.cgi`, no `...Rec.cgi`.
  it('consulta mipeAdminDocsRcp.cgi, que es el CGI del lado recibido', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(http.get).toHaveBeenLastCalledWith(
      expect.stringContaining('mipeAdminDocsRcp.cgi'), expect.any(Object));
  });

  it('selecciona la empresa por POST antes de consultar', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(http.postForm).toHaveBeenCalledWith(
      expect.stringContaining('mipeSelEmpresa.cgi'), { RUT_EMP: '33333333-3' });

    // Sin selección previa el CGI responde el error de "no ha seleccionado una
    // Empresa", así que el orden es parte del contrato y no un detalle.
    const ordenGet = (http.get as jest.Mock).mock.invocationCallOrder;
    const ordenPost = (http.postForm as jest.Mock).mock.invocationCallOrder[0];
    expect(ordenPost).toBeGreaterThan(ordenGet[0]);
    expect(ordenPost).toBeLessThan(ordenGet[1]);
  });

  it('parsea las 8 columnas con el EMISOR como contraparte', async () => {
    const { scraper } = conHistorial();

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(res.documentos).toHaveLength(3);
    expect(res.documentos[0]).toEqual({
      emisorRut: '11111111-1',
      emisorNombre: 'ASESORÍAS GENÉRICAS LTDA',
      tipoDte: 34,
      tipoDteNombre: 'Factura Exenta Electronica',
      folio: 205,
      fecha: '2023-07-19',
      monto: 592370,
      estado: 'DTE Recibido Sin Reparos',
      codigo: '1111111111',
    });
  });

  // Medido en vivo: 3 de 100 documentos venían con tipoDte=0 porque el portal
  // escribe "Guia de Despacho Electronica" y el catálogo sólo tenía "Guia de
  // Despacho". Un consumidor que filtre por tipo los pierde sin enterarse.
  it('reconoce el tipo con el sufijo "Electronica" que usa el portal', async () => {
    const { scraper } = conHistorial();

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    const guia = res.documentos.find(d => d.folio === 412)!;
    expect(guia.tipoDteNombre).toBe('Guia de Despacho Electronica');
    expect(guia.tipoDte).toBe(52);
  });

  it('conserva el CODIGO del link, que no se deriva del folio', async () => {
    const { scraper } = conHistorial();

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(res.documentos.map(d => d.codigo))
      .toEqual(['1111111111', '2222222222', '3333333333']);
  });

  it('cuenta las páginas por los enlaces de paginación', async () => {
    const { scraper } = conHistorial();

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(res.totalPaginas).toBe(3);
    expect(res.pagina).toBe(1);
    expect(res.empresaRut).toBe('33333333-3');
  });

  // El filtro por contraparte es por EMISOR y el portal lo llama `RUT_EMI`: con
  // el nombre de emitidos (`RUT_RECP`) el CGI ignora el filtro y devuelve TODO,
  // que se lee como "este emisor mandó cien documentos".
  it('manda el filtro de emisor como RUT_EMI', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({ empresaRut: '33333333-3', emisorRut: '11111111-1' });

    expect(http.get).toHaveBeenLastCalledWith(
      expect.any(String), expect.objectContaining({ RUT_EMI: '11111111-1' }));
  });

  it('traduce las fechas al formato del portal', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({
      empresaRut: '33333333-3', fechaDesde: '2024-01-15', fechaHasta: '2024-02-28',
    });

    expect(http.get).toHaveBeenLastCalledWith(expect.any(String),
      expect.objectContaining({ FEC_DESDE: '15/01/2024', FEC_HASTA: '28/02/2024' }));
  });

  it('pide la página que se le pasa', async () => {
    const { scraper, http } = conHistorial();

    await scraper.listDteRecibidos({ empresaRut: '33333333-3', pagina: 3 });

    expect(http.get).toHaveBeenLastCalledWith(expect.any(String),
      expect.objectContaining({ NUM_PAG: '3' }));
  });

  it.each([0, -1, 1.5])('rechaza una página inválida (%p)', async (pagina) => {
    const { scraper } = conHistorial();

    await expect(scraper.listDteRecibidos({ empresaRut: '33333333-3', pagina }))
      .rejects.toThrow(/pagina debe ser un entero/);
  });

  it('reporta el error propio del CGI cuando falta la selección de empresa', async () => {
    const { scraper } = conHistorial(SIN_EMPRESA);

    await expect(scraper.listDteRecibidos({ empresaRut: '33333333-3' }))
      .rejects.toThrow(/no ha seleccionado una empresa/i);
  });

  // Una fila que ES de datos y que el parser no supo leer no se saltea en
  // silencio: cien documentos convertidos en lista vacía se leen como "esta
  // empresa no recibió nada", que es el vacío ambiguo de siempre.
  it('falla si hay filas de datos que no puede interpretar', async () => {
    const roto = `<table><tbody><tr>
      <td><a href="/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=999">ver</a></td>
      <td>11111111-1</td><td>ALGUIEN</td>
    </tr></tbody></table>`;
    const { scraper } = conHistorial(roto);

    await expect(scraper.listDteRecibidos({ empresaRut: '33333333-3' }))
      .rejects.toThrow(/no pudo interpretar/);
  });

  it('una tabla sin filas de datos devuelve vacío sin fallar', async () => {
    const { scraper } = conHistorial('<table><tbody></tbody></table>');

    const res = await scraper.listDteRecibidos({ empresaRut: '33333333-3' });

    expect(res.documentos).toEqual([]);
    // Sin enlaces de paginación no se puede afirmar cuántas páginas hay, y
    // decir "1" haría parecer completo un historial que no se pudo leer.
    expect(res.totalPaginas).toBeNull();
  });
});

describe('MipymeHttpScraper.dtePdf', () => {
  function conPdf(contenido: Buffer, contentType = 'application/pdf') {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(SEL_EMPRESA);
    (http.postForm as jest.Mock).mockResolvedValue('<html></html>');
    (http.getBinario as jest.Mock) = jest.fn()
      .mockResolvedValue({ contenido, contentType });
    return { scraper, http };
  }

  const PDF = Buffer.from('%PDF-1.4 contenido');

  // Sale de mipeShowPdf.cgi y NO de mipeDownLoad/mipeImprimeDocAdm, que bajan el
  // lote entero según los filtros de la pantalla y encima los dispara un
  // reCAPTCHA: no son un camino que un servicio pueda recorrer solo.
  it('pide el PDF a mipeShowPdf.cgi con el CODIGO', async () => {
    const { scraper, http } = conPdf(PDF);

    await scraper.dtePdf('1897586940', '33333333-3');

    expect(http.getBinario).toHaveBeenCalledWith(
      expect.stringContaining('mipeShowPdf.cgi'), { CODIGO: '1897586940' });
  });

  // Sin seleccionar empresa el CGI responde "Su requerimiento no ha sido bien
  // recepcionado": un error genérico que manda a revisar el navegador cuando lo
  // que falta es el contexto. Medido contra el portal real.
  it('selecciona la empresa antes de pedir el PDF', async () => {
    const { scraper, http } = conPdf(PDF);

    await scraper.dtePdf('1897586940', '33333333-3');

    expect(http.postForm).toHaveBeenCalledWith(
      expect.stringContaining('mipeSelEmpresa.cgi'), { RUT_EMP: '33333333-3' });
    expect((http.postForm as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((http.getBinario as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('devuelve el binario tal cual', async () => {
    const { scraper } = conPdf(PDF);

    await expect(scraper.dtePdf('1897586940', '33333333-3')).resolves.toEqual(PDF);
  });

  // El CGI responde 200 con HTML cuando algo falla, así que el status no
  // distingue nada. Sin este chequeo el error viajaría como un "PDF" que ningún
  // lector abre, y el consumidor lo descubriría recién al abrirlo.
  it('un HTML de error no pasa por PDF', async () => {
    const html = Buffer.from('<html>Error al contribuyente CODIGO: 02.35.209.59</html>');
    const { scraper } = conPdf(html, 'text/html');

    await expect(scraper.dtePdf('1897586940', '33333333-3'))
      .rejects.toThrow(/no devolvió un PDF/);
  });

  it('el error del portal incluye el código del SII, que es lo que pide la mesa de ayuda', async () => {
    const html = Buffer.from('<html>CODIGO: 02.35.209.59.203.2</html>');
    const { scraper } = conPdf(html, 'text/html');

    await expect(scraper.dtePdf('1897586940', '33333333-3'))
      .rejects.toThrow(/02\.35\.209\.59\.203\.2/);
  });

  // El identificador es el `codigo` del listado, no el folio: el folio se repite
  // entre emisores y entre tipos, así que no identifica un documento.
  it.each(['205', 'abc', '', '12-34'])('rechaza un codigo que no es del listado (%p)', async (codigo) => {
    const { scraper, http } = conPdf(PDF);

    if (/^\d+$/.test(codigo)) {
      // '205' SÍ es sólo dígitos: es un folio, y el scraper no puede saberlo.
      // La distinción folio/codigo la hace el consumidor; acá sólo se valida la
      // forma, y el portal responderá su propio error si el código no existe.
      await scraper.dtePdf(codigo, '33333333-3');
      expect(http.getBinario).toHaveBeenCalled();
      return;
    }
    await expect(scraper.dtePdf(codigo, '33333333-3')).rejects.toThrow(/codigo/i);
  });
});

describe('MipymeHttpScraper.listBorradores', () => {
  function conRespuesta(cuerpo: string) {
    const { scraper, http } = armar();
    (http.get as jest.Mock).mockResolvedValue(cuerpo);
    return { scraper, http };
  }

  // El bundle lo declara con `createGetOperation`, y el servidor lo confirma: un
  // POST con el sobre SDI devuelve 500 "No resource method found for POST".
  // Medido contra el servicio real.
  it('consulta por GET, no con el sobre SDI', async () => {
    const { scraper, http } = conRespuesta('[]');

    await scraper.listBorradores();

    expect(http.get).toHaveBeenCalledWith(
      expect.stringContaining('/borradorService/listaBorrador'));
    expect(http.postSdi).not.toHaveBeenCalled();
  });

  // La URL y el namespace nombran distinto la misma operación
  // (`listaBorrador` contra `listado`). Este test fija el segmento de la URL,
  // que es el que dio 404 cuando se usó el del namespace.
  it('usa el segmento de URL del bundle y no el del namespace', async () => {
    const { scraper, http } = conRespuesta('[]');

    await scraper.listBorradores();

    const url = (http.get as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('listaBorrador');
    expect(url).not.toMatch(/\/listado$/);
  });

  it('mapea codigo y tipo de documento de los campos del SII', async () => {
    const { scraper } = conRespuesta(JSON.stringify([
      { ehdr_CODIGO: 12345, ptdc_CODIGO: 33, EFXP_RZNSOC_RECEP: 'ALGUIEN SPA' },
    ]));

    const res = await scraper.listBorradores();

    expect(res).toEqual([{
      codigo: '12345',
      tipoDte: 33,
      // Los campos del SII se publican enteros y sin renombrar: un borrador
      // trae decenas de `EFXP_*` que dependen del tipo, y elegir cuáles exponer
      // sería adivinar qué necesita el consumidor.
      campos: { ehdr_CODIGO: 12345, ptdc_CODIGO: 33, EFXP_RZNSOC_RECEP: 'ALGUIEN SPA' },
    }]);
  });

  // El código es un identificador opaco: se publica como string aunque el SII lo
  // mande numérico, para que no se aritmetice y no rompa si le agregan letras.
  it('el codigo viaja como string aunque el SII lo mande numérico', async () => {
    const { scraper } = conRespuesta(JSON.stringify([{ ehdr_CODIGO: 987, ptdc_CODIGO: 61 }]));

    const res = await scraper.listBorradores();

    expect(res[0].codigo).toBe('987');
  });

  it('un tipo ausente queda en null, no en cero', async () => {
    const { scraper } = conRespuesta(JSON.stringify([{ ehdr_CODIGO: 1 }]));

    const res = await scraper.listBorradores();

    expect(res[0].tipoDte).toBeNull();
  });

  it('acepta la lista envuelta en data', async () => {
    const { scraper } = conRespuesta(JSON.stringify({ data: [{ ehdr_CODIGO: 7, ptdc_CODIGO: 34 }] }));

    const res = await scraper.listBorradores();

    expect(res).toHaveLength(1);
    expect(res[0].codigo).toBe('7');
  });

  it('sin borradores devuelve una lista vacía', async () => {
    const { scraper } = conRespuesta('[]');

    await expect(scraper.listBorradores()).resolves.toEqual([]);
  });

  // El servidor de aplicaciones responde HTML en sus errores (404, 500, login).
  // Sin este mensaje el fallo llegaría como "Unexpected token <", que no dice
  // nada de lo que pasó.
  it('un HTML de error no se confunde con una respuesta', async () => {
    const { scraper } = conRespuesta('<html>HTTP Status 404</html>');

    await expect(scraper.listBorradores()).rejects.toThrow(/no devolvió JSON/);
  });

  // Un JSON que no es una lista tampoco es "no hay borradores": devolver [] haría
  // que "el SII contestó otra cosa" y "no tenés borradores" se lean idénticos.
  it('un JSON que no es lista es un error explícito', async () => {
    const { scraper } = conRespuesta(JSON.stringify({ metaData: { respCode: 99, msgError: 'sin permiso' } }));

    await expect(scraper.listBorradores()).rejects.toThrow(/no devolvió una lista.*99.*sin permiso/s);
  });
});
