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
    expect(informe.folioInicial).toBeNull();
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
      fecha: '22/05/2025',
      receptorRut: '22222222-2',
      receptorNombre: 'EMPRESA EJEMPLO SPA',
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
