import { BheAnulacionScraper } from '../../src/scrapers/bheAnulacion';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { EscrituraRechazadaPorSii } from '../../src/erroresConsulta';
import { esSeguroDeLiberar } from '../../src/idempotenciaEscritura';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// --- fixtures con las formas relevadas del portal ----------------------------

const PASO1_OK = '<html><script>var xml_values = new Array(); '
  + 'xml_values[\'rut_autentificado\'] = "11111111"; xml_values[\'dv_autentificado\'] = "1";</script>'
  + '<form name="formulario" method="post"><script>'
  + 'CampoOculto("rut_arrastre",xml_values[\'rut_autentificado\']); '
  + 'CampoOculto("dv_arrastre",xml_values[\'dv_autentificado\']); '
  + 'CampoOculto("origen","SEXTO");</script>'
  + '<input name="Txt_BoletaAnular" type="text"></form></html>';

// El paso 2 real: boleta renderizada por JS y botón ConfirmarAnulacion().
const PASO2_OK = '<html><script>var xml_values = new Array(); '
  + 'xml_values[\'nro_boleta\'] = "341"; xml_values[\'codigo_causa\'] = "3"; '
  + 'xml_values[\'rut_ctr\'] = "11111111"; xml_values[\'dv_ctr\'] = "1";</script>'
  + '<form name="formulario" method="post"><script>'
  + 'CampoOculto("rut_arrastre",xml_values[\'rut_ctr\']); '
  + 'CampoOculto("Txt_CodigoCausa",xml_values[\'codigo_causa\']); '
  + 'CampoOculto("Txt_BoletaAnular",xml_values[\'nro_boleta\']);</script>'
  + '<input name="BtnConfirmar" type="button" onclick="javascript:ConfirmarAnulacion()"></form>'
  + 'Paso 2 de 3</html>';

// La página de éxito real: "Paso 3 de 3" renderizado por JS, texto casi vacío.
const PASO3_OK = '<html><body>ANULACION DE BOLETAS DE HONORARIOS ELECTRONICAS Paso 3 de 3</body></html>';

const RECHAZO = '<html><body>Sr. Contribuyente: La boleta ya se encuentra anulada.</body></html>';

const LOGIN = '<html><title>Aut</title>Ingresar Clave Tributaria IngresoRutClave</html>';

function armar(r: { paso1?: string; paso2?: string; paso3?: string } = {}) {
  const session = new MockSession({} as never, {} as never);
  const http = new MockHttp(session);
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => undefined);
  (http.get as jest.Mock).mockResolvedValue(r.paso1 ?? PASO1_OK);
  (http.postForm as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('ConfirmarAnulacion')) return r.paso2 ?? PASO2_OK;
    return r.paso3 ?? PASO3_OK;
  });
  return { scraper: new BheAnulacionScraper(http, session), http };
}

describe('BheAnulacionScraper.anular', () => {
  it('dry-run (confirmar:false): llega al paso 2 y NO postea la recepción', async () => {
    const { scraper, http } = armar();
    const r = await scraper.anular(341, 3, false);
    expect(r.anulada).toBe(false);
    const urls = (http.postForm as jest.Mock).mock.calls.map(c => c[0] as string);
    expect(urls.some(u => u.includes('RecepcionAnulacion'))).toBe(false);
  });

  it('propaga los campos del paso 1 y agrega folio y causa al paso 2', async () => {
    const { scraper, http } = armar();
    await scraper.anular(341, 3, false);
    const paso2 = (http.postForm as jest.Mock).mock.calls.find(c => (c[0] as string).includes('ConfirmarAnulacion'));
    const campos = paso2![1] as Record<string, string>;
    expect(campos.rut_arrastre).toBe('11111111');
    expect(campos.origen).toBe('SEXTO');
    expect(campos.Txt_BoletaAnular).toBe('341');
    expect(campos.OptCausaAnulacion).toBe('3');
  });

  it('confirmar:true reconoce el éxito por "Paso 3 de 3" (página renderizada por JS)', async () => {
    const { scraper } = armar();
    const r = await scraper.anular(341, 3, true);
    expect(r.anulada).toBe(true);
    expect(r.folio).toBe(341);
  });

  it('un rechazo del paso 2 es EscrituraRechazadaPorSii y ES seguro de liberar', async () => {
    const { scraper } = armar({ paso2: RECHAZO });
    const err = await scraper.anular(341, 3, true).catch(e => e);
    expect(err).toBeInstanceOf(EscrituraRechazadaPorSii);
    expect(esSeguroDeLiberar(err)).toBe(true);
  });

  it('la sesión caída en el paso 3 (el que anula) NO se marca segura', async () => {
    const { scraper } = armar({ paso3: LOGIN });
    const err = await scraper.anular(341, 3, true).catch(e => e);
    expect(err.message).toMatch(/PUDO o no/);
    expect(esSeguroDeLiberar(err)).toBe(false);
  });
});
