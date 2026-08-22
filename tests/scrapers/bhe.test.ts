import * as fs from 'fs';
import * as path from 'path';
import { BheScraper } from '../../src/scrapers/bhe';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '../fixtures', nombre), 'latin1');
}

function makeScraper(html: string) {
  const http = new MockHttp({} as any);
  const session = new MockSession({} as any, {} as any);
  // Se mockean ambos verbos: el informe anual usa GET y el mensual POST.
  (http.get as jest.Mock).mockResolvedValue(html);
  (http.postForm as jest.Mock).mockResolvedValue(html);
  (session.authenticateOnly as jest.Mock).mockResolvedValue(undefined);
  (session.identidad as jest.Mock).mockReturnValue({ rut: '11111111', dv: '1' });
  return { http, session, scraper: new BheScraper(http, session) };
}

describe('BheScraper.informeAnual', () => {
  it('parsea la cabecera del informe', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(informe.anio).toBe(2025);
    expect(informe.rut).toBe('11111111-1');
    expect(informe.nombreContribuyente).toBe('JUAN PEREZ SOTO');
  });

  it('parsea los meses con actividad y omite los vacíos', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses).toHaveLength(2);
    expect(informe.meses[0]).toEqual({
      mes: 1,
      honorarioBruto: 1000000,
      retencionTerceros: 145000,
      retencionContribuyente: 0,
      folioInicial: 101,
      folioFinal: 102,
      emisionesVigentes: 2,
      emisionesAnuladas: 1,
    });
  });

  // Una columna ausente significa cero emisiones anuladas, no un dato perdido.
  it('trata las columnas vacías como cero', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses[1].emisionesAnuladas).toBe(0);
  });

  it('expone el rango de folios del año', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(informe.folioInicial).toBe(101);
    expect(informe.folioFinal).toBe(103);
  });

  // Un año sin boletas es una respuesta legítima, no un fallo.
  it('devuelve lista vacía cuando el año no tiene boletas', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-anual-vacio.html'));

    const informe = await scraper.informeAnual(2019);

    expect(informe.meses).toEqual([]);
    // La respuesta real de un año sin boletas trae tot4/tot5 en "0", no
    // ausentes: el informe existe, sólo que sin folios emitidos.
    expect(informe.folioInicial).toBe(0);
  });

  // Sin esto, una sesión caída o una página de error se parsean como "el año
  // no tuvo boletas", que es indistinguible de un año realmente vacío.
  it('falla si la respuesta no es un informe de BHE', async () => {
    const { scraper } = makeScraper('<html><body>Sesión expirada</body></html>');

    await expect(scraper.informeAnual(2025)).rejects.toThrow(/no devolvió un informe/);
  });

  it('consulta el CGI anual con el año pedido', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-anual.html'));

    await scraper.informeAnual(2025);

    const [url, params] = (http.get as jest.Mock).mock.calls[0];
    expect(url).toContain('TMBCOC_InformeAnualBhe.cgi');
    expect(params.cbanoinformeanual).toBe('2025');
    expect(params.rut_arrastre).toBe('11111111');
    expect(params.dv_arrastre).toBe('1');
  });

  it('autentica sin exigir selección de empresa', async () => {
    const { scraper, session } = makeScraper(fixture('bhe-informe-anual.html'));

    await scraper.informeAnual(2025);

    expect(session.authenticateOnly).toHaveBeenCalled();
    expect(session.getSession).not.toHaveBeenCalled();
  });

  // No hay evidencia de que el SII emita montos negativos en este informe,
  // pero si alguna vez ocurre (ej. una corrección), truncar el signo
  // corrompería el dato en silencio. Se arma el HTML a mano porque las
  // fixtures no deben tocarse y no representan este caso.
  it('preserva el signo negativo de un monto', async () => {
    const html = `<html><body><script>
 xml_values['nombre_contribuyente'] = "JUAN PEREZ SOTO ";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['anio_consulta'] = "2025";
 xml_values['ene1']= "-15000";
 xml_values['ene2']= "0";
 xml_values['ene3']= "0";
 xml_values['ene4']= "101";
 xml_values['ene5']= "101";
 xml_values['ene6']= "1";
 xml_values['ene7']= "";
 xml_values['tot4']= "101";
 xml_values['tot5']= "101";
</script></body></html>`;
    const { scraper } = makeScraper(html);

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses[0].honorarioBruto).toBe(-15000);
  });

  // El punto SÍ debe seguir descartándose: el SII lo usa como separador de
  // miles en varios módulos (ver src/scrapers/bienesRaices.ts, que depende de
  // este mismo comportamiento para el avalúo fiscal).
  it('sigue quitando el separador de miles de un monto positivo', async () => {
    const html = `<html><body><script>
 xml_values['nombre_contribuyente'] = "JUAN PEREZ SOTO ";
 xml_values['rut_arrastre'] = "11111111";
 xml_values['dv_arrastre'] = "1";
 xml_values['anio_consulta'] = "2025";
 xml_values['ene1']= "3.884.935";
 xml_values['ene2']= "0";
 xml_values['ene3']= "0";
 xml_values['ene4']= "101";
 xml_values['ene5']= "101";
 xml_values['ene6']= "1";
 xml_values['ene7']= "";
 xml_values['tot4']= "101";
 xml_values['tot5']= "101";
</script></body></html>`;
    const { scraper } = makeScraper(html);

    const informe = await scraper.informeAnual(2025);

    expect(informe.meses[0].honorarioBruto).toBe(3884935);
  });
});

describe('BheScraper.informeMensual', () => {
  it('parsea las boletas del mes', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-mensual.html'));

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas).toHaveLength(2);
    expect(boletas[0]).toEqual({
      folio: 311,
      // Es lo único que el SII acepta para pedir el PDF de esta boleta.
      codigoBarras: '111111110000048F99ED',
      fecha: '22/05/2025',
      contraparteRol: 'receptor',
      contraparteRut: '22222222-2',
      contraparteNombre: 'EMPRESA EJEMPLO SPA',
      honorarioBruto: 1000000,
      retencionEmisor: 0,
      retencionReceptor: 145000,
      totalLiquido: 855000,
      anulada: false,
    });
  });

  // Los montos vienen envueltos en formatMiles("1000000",'.'), no como string
  // pelado: un parser que no lo contemple devuelve la expresion o nada.
  it('desenvuelve los montos de formatMiles', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-mensual.html'));

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas[1].honorarioBruto).toBe(2000000);
    expect(boletas[1].retencionReceptor).toBe(290000);
  });

  it('usa el CGI de emitidas por defecto', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-mensual.html'));
    await scraper.informeMensual(2025, 5);
    expect((http.postForm as jest.Mock).mock.calls[0][0])
      .toContain('TMBCOC_InformeMensualBhe.cgi');
  });

  it('usa el CGI con sufijo Rec para las recibidas', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-mensual.html'));
    await scraper.informeMensual(2025, 5, true);
    expect((http.postForm as jest.Mock).mock.calls[0][0])
      .toContain('TMBCOC_InformeMensualBheRec.cgi');
  });

  // El formulario del portal manda el mes con dos digitos; con uno solo el SII
  // responde el informe vacio en vez de un error, que es la peor combinacion.
  it('rellena el mes a dos digitos y manda pagina_solicitada', async () => {
    const { scraper, http } = makeScraper(fixture('bhe-informe-mensual.html'));
    await scraper.informeMensual(2025, 3);
    const campos = (http.postForm as jest.Mock).mock.calls[0][1];
    expect(campos.cbmesinformemensual).toBe('03');
    expect(campos.cbanoinformemensual).toBe('2025');
    expect(campos.pagina_solicitada).toBe('0');
    expect(campos.rut_arrastre).toBe('11111111');
  });

  it('falla si la respuesta no es un informe', async () => {
    const { scraper } = makeScraper('<html><body>Sesion expirada</body></html>');
    await expect(scraper.informeMensual(2025, 5)).rejects.toThrow(/no devolvió un informe/);
  });
});

// Emitidas y recibidas NO comparten esquema: el CGI de recibidas usa otros
// nombres de campo. Parseando con los de emitidas, cada boleta recibida salía
// con RUT "-" y nombre vacío, sin lanzar nada.
describe('BheScraper.informeMensual de recibidas', () => {
  it('parsea la contraparte como emisor, con los nombres de campo de recibidas', async () => {
    const { scraper } = makeScraper(fixture('bhe-informe-mensual-recibidas.html'));

    const boletas = await scraper.informeMensual(2025, 5, true);

    expect(boletas).toHaveLength(1);
    expect(boletas[0]).toEqual({
      folio: 3436,
      // Las recibidas también traen el código, así que su PDF se puede pedir.
      codigoBarras: '033333333034364C969E7',
      // El CGI de recibidas no emite fechaemision_N: la fecha vive en
      // fecha_boleta_N.
      fecha: '05/05/2025',
      contraparteRol: 'emisor',
      contraparteRut: '33333333-3',
      contraparteNombre: 'PEDRO GOMEZ LARRAIN',
      honorarioBruto: 500000,
      // El receptor no ve la retención declarada por el emisor: el campo no
      // existe en esta respuesta, y null lo dice sin inventar un cero.
      retencionEmisor: null,
      retencionReceptor: 0,
      totalLiquido: 500000,
      anulada: false,
    });
  });
});

describe('BheScraper.informeMensual con más de una página', () => {
  // El CGI entrega 100 filas por página, pero total_boletas es el total del mes.
  // Antes se devolvían 100 boletas presentadas como el mes completo.
  it('falla explícitamente en vez de devolver un listado truncado', async () => {
    const html = `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "150";
 arr_informe_mensual['nroboleta_1'] = "311";
</script></html>`;
    const { scraper } = makeScraper(html);

    await expect(scraper.informeMensual(2025, 5))
      .rejects.toThrow(/150 boletas.*paginación todavía no está implementada/s);
  });

  it('no reintenta la consulta por una limitación que ya conoce', async () => {
    const html = `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "150";
</script></html>`;
    const { scraper, http, session } = makeScraper(html);

    await expect(scraper.informeMensual(2025, 5)).rejects.toThrow();

    expect((http.postForm as jest.Mock).mock.calls).toHaveLength(1);
    expect(session.invalidate).not.toHaveBeenCalled();
  });

  it('acepta un mes de exactamente 100 boletas', async () => {
    const filas = Array.from({ length: 100 }, (_, i) =>
      ` arr_informe_mensual['nroboleta_${i + 1}'] = "${300 + i}";`
    ).join('\n');
    const html = `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "100";
${filas}
</script></html>`;
    const { scraper } = makeScraper(html);

    expect(await scraper.informeMensual(2025, 5)).toHaveLength(100);
  });
});

// El PDF se pide por código de barras a un CGI distinto (TMBCOT_, no TMBCOC_)
// y la respuesta es binaria, así que no pasa por el parser de informes.
describe('BheScraper.pdfBoleta', () => {
  const PDF = Buffer.from('%PDF-1.3\n...bytes...', 'latin1');

  function makePdfScraper(
    respuesta: { contenido: Buffer; contentType: string }
  ) {
    const { scraper, http, session } = makeScraper('<html></html>');
    (http.getBinario as jest.Mock).mockResolvedValue(respuesta);
    return { scraper, http, session };
  }

  it('devuelve los bytes del PDF tal cual', async () => {
    const { scraper } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });

    const pdf = await scraper.pdfBoleta('111111110000048F99ED');

    expect(pdf).toEqual(PDF);
  });

  it('pide el CGI del PDF con el código de barras y origen PROPIOS', async () => {
    const { scraper, http } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });

    await scraper.pdfBoleta('111111110000048F99ED');

    const [url, params] = (http.getBinario as jest.Mock).mock.calls[0];
    expect(url).toContain('TMBCOT_ConsultaBoletaPdf.cgi');
    expect(params).toEqual({
      txt_codigobarras: '111111110000048F99ED',
      veroriginal: 'si',
      origen: 'PROPIOS',
      enviar: 'si',
    });
  });

  it('usa origen RECIBIDOS para una boleta recibida', async () => {
    const { scraper, http } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });

    await scraper.pdfBoleta('033333333034364C969E7', true);

    expect((http.getBinario as jest.Mock).mock.calls[0][1].origen).toBe('RECIBIDOS');
  });

  // El CGI responde 200 con el HTML del formulario de login cuando la sesión no
  // le sirve: sin mirar el Content-Type, ese HTML se entregaría como "PDF".
  it('falla si el SII responde algo que no es un PDF', async () => {
    const { scraper } = makePdfScraper({
      contenido: Buffer.from('<html><title>Autenticación</title></html>', 'latin1'),
      contentType: 'text/html; charset=iso-8859-1',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED'))
      .rejects.toThrow(/no devolvió un PDF.*text\/html/s);
  });

  // Las dos causas llegan con el mismo Content-Type, pero sólo una se arregla
  // reintentando: quien recibe el ERROR genérico del contrato REST necesita que
  // el mensaje lo diga.
  it('nombra la sesión expirada cuando el cuerpo es el formulario de login', async () => {
    const { scraper } = makePdfScraper({
      contenido: Buffer.from('<html><head><title>Autenticación</title></head></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED'))
      .rejects.toThrow(/la sesión expiró: reintentá/);
  });

  it('nombra el código ajeno cuando el cuerpo no es el formulario de login', async () => {
    const { scraper } = makePdfScraper({
      contenido: Buffer.from('<html><title>Boletas de honorarios</title></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.pdfBoleta('99999999999999999999'))
      .rejects.toThrow(/no corresponde a una boleta de este RUT/);
  });

  // El listado deja el campo vacío cuando el SII no lo informa. Mandarlo así
  // haría que el CGI devuelva el login, y el error apuntaría a la sesión.
  it('rechaza un código de barras vacío sin consultar al SII', async () => {
    const { scraper, http, session } = makePdfScraper({ contenido: PDF, contentType: 'application/pdf' });

    await expect(scraper.pdfBoleta('   ')).rejects.toThrow(/Falta el código de barras/);

    expect(http.getBinario as jest.Mock).not.toHaveBeenCalled();
    expect(session.authenticateOnly).not.toHaveBeenCalled();
    // Y no tira abajo la sesión: la validación va fuera de conSesionFresca, que
    // si no invalidaría una sesión sana por un input inválido del tenant.
    expect(session.invalidate).not.toHaveBeenCalled();
  });

  // conSesionFresca reintenta todo lo que no sea LimitacionConocida. Un código
  // ajeno al RUT no se arregla reautenticando: reintentarlo gasta un re-login y
  // una consulta para fallar igual.
  it('no reintenta cuando el código no corresponde al RUT', async () => {
    const { scraper, http, session } = makePdfScraper({
      contenido: Buffer.from('<html><title>Boletas de honorarios</title></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.pdfBoleta('99999999999999999999')).rejects.toThrow();

    expect((http.getBinario as jest.Mock).mock.calls).toHaveLength(1);
    expect(session.invalidate).not.toHaveBeenCalled();
  });

  // La sesión caída sí se arregla reautenticando, así que acá el reintento debe
  // ocurrir: es la diferencia con el caso de arriba.
  it('reintenta cuando el SII devolvió el formulario de login', async () => {
    const { scraper, http, session } = makePdfScraper({
      contenido: Buffer.from('<html><title>Autenticación</title></html>', 'latin1'),
      contentType: 'text/html',
    });

    await expect(scraper.pdfBoleta('111111110000048F99ED')).rejects.toThrow();

    expect((http.getBinario as jest.Mock).mock.calls).toHaveLength(2);
    expect(session.invalidate).toHaveBeenCalled();
  });
});

describe('BheScraper y el valor de arr_informe_mensual', () => {
  // El regex cortaba el valor en el primer ";", así que una razón social con
  // entidades HTML quedaba sin comilla de cierre y el nombre desaparecía.
  it('conserva una razón social que contiene punto y coma dentro del literal', async () => {
    const html = `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "1";
 arr_informe_mensual['nroboleta_1'] = "311";
 arr_informe_mensual['nombrereceptor_1'] = "SOC. GARC&Iacute;A &amp; CIA";
</script></html>`;
    const { scraper } = makeScraper(html);

    const boletas = await scraper.informeMensual(2025, 5);

    // Además se decodifican las entidades: el nombre se devuelve legible.
    expect(boletas[0].contraparteNombre).toBe('SOC. GARCÍA & CIA');
  });

  it('decodifica también las entidades numéricas', async () => {
    const html = `<html><script>
 xml_values['anio_consulta'] = "2025";
 xml_values['total_boletas'] = "1";
 arr_informe_mensual['nroboleta_1'] = "311";
 arr_informe_mensual['nombrereceptor_1'] = "PE&#209;A LTDA";
</script></html>`;
    const { scraper } = makeScraper(html);

    const boletas = await scraper.informeMensual(2025, 5);

    expect(boletas[0].contraparteNombre).toBe('PEÑA LTDA');
  });
});

describe('BheScraper ante una sesión caída', () => {
  // Sin invalidar, el flag de dos horas da la autenticación por buena y cada
  // reintento repite el mismo fallo hasta reiniciar el proceso: el consejo
  // "reintentá" que da el mensaje de error era el único que no podía funcionar.
  it('invalida la sesión y reintenta una vez el informe anual', async () => {
    const { scraper, http, session } = makeScraper('');
    (http.get as jest.Mock)
      .mockResolvedValueOnce('<html>Sesión expirada</html>')
      .mockResolvedValueOnce(fixture('bhe-informe-anual.html'));

    const informe = await scraper.informeAnual(2025);

    expect(session.invalidate).toHaveBeenCalledTimes(1);
    expect(informe.anio).toBe(2025);
  });

  it('invalida la sesión y reintenta una vez el informe mensual', async () => {
    const { scraper, http, session } = makeScraper('');
    (http.postForm as jest.Mock)
      .mockResolvedValueOnce('<html>Sesión expirada</html>')
      .mockResolvedValueOnce(fixture('bhe-informe-mensual.html'));

    const boletas = await scraper.informeMensual(2025, 5);

    expect(session.invalidate).toHaveBeenCalledTimes(1);
    expect(boletas).toHaveLength(2);
  });

  it('propaga el error si tampoco funciona con la sesión nueva', async () => {
    const { scraper, session } = makeScraper('<html>Sesión expirada</html>');

    await expect(scraper.informeAnual(2025)).rejects.toThrow(/no devolvió un informe/);
    expect(session.invalidate).toHaveBeenCalledTimes(1);
  });
});
