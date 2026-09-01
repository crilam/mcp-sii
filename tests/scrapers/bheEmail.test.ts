import { BheEmailScraper } from '../../src/scrapers/bheEmail';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { EscrituraRechazadaPorSii } from '../../src/erroresConsulta';
import { esSeguroDeLiberar } from '../../src/idempotenciaEscritura';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

const CB = '11111111003415AAAAAA';

// Form real: hidden por CampoOculto (origen QUINTO), txt_email precargado por JS.
const FORM = '<html><script>var xml_values = new Array();'
  + 'xml_values[\'codigo_barra\'] = "' + CB + '";'
  + 'xml_values[\'email\'] = "receptor@ejemplo.cl";'
  + '</script><form name="formulario"><script>'
  + 'CampoOculto("txt_codigobarras",xml_values[\'codigo_barra\']); CampoOculto("origen","QUINTO");'
  + '</script><input type="text" name="txt_email" value="">'
  + '<script>document.formulario.txt_email.value = xml_values[\'email\'];</script>'
  + '</form></html>';

const ENVIADA = '<html><body>La boleta ha sido enviada al correo indicado.</body></html>';
const LOGIN = '<html>Ingresar Clave Tributaria IngresoRutClave</html>';

function armar(r: { form?: string; envio?: string } = {}) {
  const session = new MockSession({} as never, {} as never);
  const http = new MockHttp(session);
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => undefined);
  (http.get as jest.Mock).mockResolvedValue(r.form ?? FORM);
  (http.postForm as jest.Mock).mockResolvedValue(r.envio ?? ENVIADA);
  return { scraper: new BheEmailScraper(http, session), http };
}

describe('BheEmailScraper.enviar', () => {
  it('dry-run: devuelve el email del portal y NO postea', async () => {
    const { scraper, http } = armar();
    const r = await scraper.enviar(CB, undefined, false);
    expect(r.enviado).toBe(false);
    expect((r as { emailDestino: string }).emailDestino).toBe('receptor@ejemplo.cl');
    expect(http.postForm).not.toHaveBeenCalled();
  });

  it('confirmar:true postea al CGI del PDF con el email pedido y el origen del form', async () => {
    const { scraper, http } = armar();
    const r = await scraper.enviar(CB, 'otro@ejemplo.cl', true);
    expect(r.enviado).toBe(true);
    const [url, campos] = (http.postForm as jest.Mock).mock.calls[0] as [string, Record<string, string>];
    expect(url).toContain('TMBCOT_ConsultaBoletaPdf');
    expect(campos.txt_email).toBe('otro@ejemplo.cl');
    expect(campos.origen).toBe('QUINTO');
    expect(campos.txt_codigobarras).toBe(CB);
  });

  it('sin email del portal ni pedido: rechazo seguro (no hay destinatario)', async () => {
    const { scraper } = armar({ form: FORM.replace('receptor@ejemplo.cl', '') });
    const err = await scraper.enviar(CB, undefined, true).catch(e => e);
    expect(err).toBeInstanceOf(EscrituraRechazadaPorSii);
    expect(esSeguroDeLiberar(err)).toBe(true);
  });

  it('un email inválido falla antes de tocar el portal', async () => {
    const { scraper, http } = armar();
    await expect(scraper.enviar(CB, 'no-valido', true)).rejects.toThrow(/no es válido/);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('la sesión caída en el paso que envía NO se marca segura', async () => {
    const { scraper } = armar({ envio: LOGIN });
    const err = await scraper.enviar(CB, undefined, true).catch(e => e);
    expect(err.message).toMatch(/PUDO o no/);
    expect(esSeguroDeLiberar(err)).toBe(false);
  });
});
