import { BheObservacionScraper } from '../../src/scrapers/bheObservacion';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { EscrituraRechazadaPorSii } from '../../src/erroresConsulta';
import { esSeguroDeLiberar } from '../../src/idempotenciaEscritura';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// Informe de recibidas: los datos van como arrays JS (forma real del portal).
const INFORME = '<html><script>var xml_values = new Array();'
  + 'xml_values[\'anio_consulta\'] = "2026";'
  + 'arr_informe_mensual[\'nroboleta_1\'] = "4514";'
  + 'arr_informe_mensual[\'codigobarras_1\'] = "22222222045141AAAAAA";'
  + 'arr_informe_mensual[\'rutemisor_1\'] = "22222222";'
  + '</script><form name="formulario"><script>'
  + 'CampoOculto("rut_arrastre","11111111"); CampoOculto("dv_arrastre","1");'
  + '</script></form></html>';

// El MISMO folio repetido por dos emisores distintos (el folio es por emisor).
const INFORME_DUPLICADO = INFORME.replace('</script><form',
  'arr_informe_mensual[\'nroboleta_2\'] = "4514";'
  + 'arr_informe_mensual[\'codigobarras_2\'] = "33333333045142BBBBBB";'
  + 'arr_informe_mensual[\'rutemisor_2\'] = "33333333";'
  + '</script><form');

// Paso 2: filas con checkbox/select por índice y ConfirmarRespuestaRechazo().
const PASO2 = '<html><script>'
  + 'arr_informe_anu[\'nroboleta_1\'] = "4514"; arr_informe_anu[\'nroboleta_2\'] = "4520";'
  + '</script><form name="formulario">'
  + '<input type="button" name="cmdConfirmar" onclick="javascript:ConfirmarRespuestaRechazo();">'
  + '</form>Paso 1 de 2</html>';

const PASO3_OK = '<html><body>Paso 2 de 2 Su solicitud ha sido registrada</body></html>';
const LOGIN = '<html>Ingresar Clave Tributaria IngresoRutClave</html>';

function armar(r: { informe?: string; paso2?: string; paso3?: string } = {}) {
  const session = new MockSession({} as never, {} as never);
  const http = new MockHttp(session);
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => undefined);
  (http.postForm as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('InformeMensualBheRec')) return r.informe ?? INFORME;
    if (url.includes('ListarBheRechazarReceptor')) return r.paso2 ?? PASO2;
    return r.paso3 ?? PASO3_OK;
  });
  return { scraper: new BheObservacionScraper(http, session), http };
}

describe('BheObservacionScraper.observar', () => {
  it('dry-run: resuelve el codigobarras del folio y NO postea la recepción', async () => {
    const { scraper, http } = armar();
    const r = await scraper.observar('11111111-1', 2026, 8, 4514, 1, false);
    expect(r.observada).toBe(false);
    const urls = (http.postForm as jest.Mock).mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes('RecepcionRespuestaRechazo'))).toBe(false);
    const paso2 = (http.postForm as jest.Mock).mock.calls.find(c => (c[0] as string).includes('ListarBheRechazar'));
    expect((paso2![1] as Record<string, string>).txt_codigobarras).toBe('22222222045141AAAAAA');
    expect((paso2![1] as Record<string, string>).nro_boleta).toBe('4514');
  });

  it('confirmar:true marca SÓLO la fila del folio y postea la recepción', async () => {
    const { scraper, http } = armar();
    const r = await scraper.observar('11111111-1', 2026, 8, 4514, 2, true);
    expect(r.observada).toBe(true);
    const paso3 = (http.postForm as jest.Mock).mock.calls.find(c => (c[0] as string).includes('RecepcionRespuestaRechazo'));
    const campos = paso3![1] as Record<string, string>;
    expect(campos.chkRechazo_1).toBe('on');
    expect(campos.cbRechazo_1).toBe('2');
    expect(campos.chkRechazo_2).toBeUndefined(); // la otra fila no viaja marcada
    expect(campos.cbRechazo_2).toBe('');
    expect(campos.nroboleta_1).toBe('4514');
    expect(campos.nroboleta_2).toBe('4520');
  });

  it('el folio duplicado entre emisores se rechaza pidiendo desambiguar', async () => {
    const { scraper } = armar({ informe: INFORME_DUPLICADO });
    const err = await scraper.observar('11111111-1', 2026, 8, 4514, 1, true).catch(e => e);
    expect(err).toBeInstanceOf(EscrituraRechazadaPorSii);
    expect(err.message).toMatch(/desambiguar|emisor/i);
    expect(esSeguroDeLiberar(err)).toBe(true);
  });

  it('con el RUT del emisor, el folio duplicado se resuelve a la boleta correcta', async () => {
    const { scraper, http } = armar({ informe: INFORME_DUPLICADO });
    await scraper.observar('11111111-1', 2026, 8, 4514, 1, false, '33333333-3');
    const paso2 = (http.postForm as jest.Mock).mock.calls.find(c => (c[0] as string).includes('ListarBheRechazar'));
    expect((paso2![1] as Record<string, string>).txt_codigobarras).toBe('33333333045142BBBBBB');
  });

  it('un folio que no está en el informe es rechazo seguro de liberar', async () => {
    const { scraper } = armar();
    const err = await scraper.observar('11111111-1', 2026, 8, 999, 1, true).catch(e => e);
    expect(err).toBeInstanceOf(EscrituraRechazadaPorSii);
    expect(esSeguroDeLiberar(err)).toBe(true);
  });

  it('la sesión caída en el paso que observa NO se marca segura', async () => {
    const { scraper } = armar({ paso3: LOGIN });
    const err = await scraper.observar('11111111-1', 2026, 8, 4514, 1, true).catch(e => e);
    expect(err.message).toMatch(/PUDO o no/);
    expect(esSeguroDeLiberar(err)).toBe(false);
  });
});
