import { BheEmisionScraper, parsearCamposForm, EmitirBheParams } from '../../src/scrapers/bheEmision';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';
import { EscrituraRechazadaPorSii, LimitacionConocida } from '../../src/erroresConsulta';
import { esSeguroDeLiberar } from '../../src/idempotenciaEscritura';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

// --- fixtures sintéticas, con las formas relevadas del portal ---------------

const PASO1_OK = '<html><form name="formulario" method="post" action="TMBECN_PresentaDatosBoleta.cgi">'
  + '<input name="OptTipoRetencion" type="radio" value="RETRECEPTOR">'
  + '<input name="OptTipoRetencion" type="radio" value="RETCONTRIBUYENTE" checked></form></html>';

// Texto REAL capturado del portal (perfil sin segunda categoría).
const PASO1_SIN_CATEGORIA = '<html><body>Sr. Contribuyente: Ud no registra actividades de segunda '
  + 'categoría, por lo tanto no puede emitir Boletas de Honorarios Electrónicas.</body></html>';

const LOGIN = '<html><title>Aut</title>Ingresar Clave Tributaria IngresoRutClave</html>';

const PASO2_FORM = '<html><form name="frmBoleta" action="TMBECN_ConfirmaTimbrajeContrib.cgi">'
  + '<input type="hidden" name="rut_arrastre" value="17270613">'
  + '<input type="hidden" name="dv_arrastre" value="4">'
  + '<input type="hidden" name="tiempo" value="1787000000">'
  + '<input type="hidden" name="hdn_glosa_actividad" value="ASESOR">'
  + '<input name="txt_rut_destinatario" value="">'
  + '<input name="txt_dv_destinatario" value="">'
  + '<input name="txt_nombres_destinatario" value="">'
  + '<input name="desc_prestacion_1" value=""><input name="valor_prestacion_1" value="">'
  + '<input type="hidden" name="cantidad_filas_ingreso" value="1">'
  + '</form></html>';

const PREVIEW = '<html><body>Vista Previa de la boleta. '
  + 'Total Honorarios: $ 2.043.689 Retención: $ 281.007 Líquido: $ 1.762.682 '
  + '<form><input type="hidden" name="tiempo" value="1787000000">'
  + '<input type="hidden" name="folio_provisorio" value="X1"></form></body></html>';

const EMITIDA = '<html><body>Su boleta ha sido emitida con éxito. Boleta N° 1234 '
  + 'Total Honorarios: $ 2.043.689 Retención: $ 281.007 Líquido: $ 1.762.682</body></html>';

const PARAMS: EmitirBheParams = {
  receptor: { rut: '66666666-6', nombre: 'RECEPTORA FICTICIA SPA' },
  lineas: [
    { descripcion: 'Servicio uno', valor: 1226213 },
    { descripcion: 'Servicio dos', valor: 817476 },
  ],
};

function armar(respuestas: { paso1?: string; paso2?: string; paso3?: string; paso4?: string } = {}) {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {});
  (http.get as jest.Mock).mockResolvedValue(respuestas.paso1 ?? PASO1_OK);
  (http.postForm as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('PresentaDatosBoleta')) return respuestas.paso2 ?? PASO2_FORM;
    if (url.includes('ConfirmaTimbraje')) return respuestas.paso3 ?? PREVIEW;
    return respuestas.paso4 ?? EMITIDA;
  });
  return { scraper: new BheEmisionScraper(http, session), http, session };
}

function urlsPosteadas(http: SiiHttpClient): string[] {
  return (http.postForm as jest.Mock).mock.calls.map(c => c[0] as string);
}

describe('parsearCamposForm', () => {
  it('toma inputs con name, ignora botones, y sólo radios checked', () => {
    const campos = parsearCamposForm(PASO1_OK + '<input type="submit" name="cmd" value="x">');
    expect(campos.OptTipoRetencion).toBe('RETCONTRIBUYENTE'); // el checked
    expect(campos.cmd).toBeUndefined();
  });
});

describe('BheEmisionScraper.emitir — dry-run (confirmar:false)', () => {
  it('recorre 1→3, devuelve los montos del SII y NO toca el paso 4', async () => {
    const { scraper, http } = armar();

    const r = await scraper.emitir(PARAMS, false);

    expect(r.emitida).toBe(false);
    const p = r as { bruto: number | null; retencion: number | null; liquido: number | null };
    expect(p.bruto).toBe(2043689);
    expect(p.retencion).toBe(281007);
    expect(p.liquido).toBe(1762682);
    expect(urlsPosteadas(http).some(u => u.includes('BoletaHonorariosElectronica'))).toBe(false);
  });

  it('propaga los campos del server (tiempo) y sobreescribe receptor y líneas', async () => {
    const { scraper, http } = armar();

    await scraper.emitir(PARAMS, false);

    const paso3 = (http.postForm as jest.Mock).mock.calls.find(c => (c[0] as string).includes('ConfirmaTimbraje'));
    const campos = paso3![1] as Record<string, string>;
    expect(campos.tiempo).toBe('1787000000');           // propagado, no regenerado
    expect(campos.rut_arrastre).toBe('17270613');       // del server
    expect(campos.txt_rut_destinatario).toBe('66666666');
    expect(campos.txt_dv_destinatario).toBe('6');
    expect(campos.desc_prestacion_1).toBe('Servicio uno');
    expect(campos.valor_prestacion_2).toBe('817476');
    expect(campos.cantidad_filas_ingreso).toBe('2');
    expect(campos.sin_destinatario).toBe('NO');
  });

  // El caso real capturado: el contribuyente sin segunda categoría. Rechazo de
  // negocio, marcado seguro (no se emitió nada).
  it('sin segunda categoría es RECHAZO_SII con el mensaje del portal, marcado seguro', async () => {
    const { scraper } = armar({ paso1: PASO1_SIN_CATEGORIA });
    const err = await scraper.emitir(PARAMS, false).catch(e => e);
    expect(err).toBeInstanceOf(EscrituraRechazadaPorSii);
    expect(err.message).toMatch(/segunda categoría/);
    expect(esSeguroDeLiberar(err)).toBe(true);
  });

  it('el rebote a login se reporta como sesión, no como rechazo', async () => {
    const { scraper } = armar({ paso1: LOGIN });
    await expect(scraper.emitir(PARAMS, false)).rejects.toThrow(/sesión.*login|login/i);
  });

  it('un paso 2 sin el formulario esperado (sin tiempo) falla explícito', async () => {
    const { scraper } = armar({ paso2: '<html><input name="rut_arrastre" value="1"></html>' });
    await expect(scraper.emitir(PARAMS, false)).rejects.toThrow(/tiempo/);
  });

  it('una previsualización sin montos legibles no se entrega', async () => {
    const { scraper } = armar({ paso3: '<html><body>Vista previa rara sin montos</body></html>' });
    await expect(scraper.emitir(PARAMS, false)).rejects.toBeInstanceOf(LimitacionConocida);
  });

  // El bloqueante del review: un monto de OTRO campo, lejos de la etiqueta, no
  // se debe tomar. Preview con "Total Honorarios" sin $ pegado y otro número
  // lejos → el monto queda null (no una cifra equivocada), y sin bruto ni
  // líquido legibles la previsualización se rechaza.
  it('no toma un monto lejano de otro campo (falla en vez de mentir)', async () => {
    const rara = '<html><body>Total Honorarios (ver detalle abajo) muchas palabras aca 999 y despues Retención sin signo</body></html>';
    const { scraper } = armar({ paso3: rara });
    await expect(scraper.emitir(PARAMS, false)).rejects.toBeInstanceOf(LimitacionConocida);
  });

  it('valida las líneas antes de tocar el SII', async () => {
    const { scraper, http } = armar();
    await expect(scraper.emitir({ ...PARAMS, lineas: [] }, false)).rejects.toThrow(/al menos una línea/);
    await expect(scraper.emitir({ ...PARAMS, lineas: Array(5).fill({ descripcion: 'x', valor: 1 }) }, false))
      .rejects.toThrow(/hasta 4/);
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe('BheEmisionScraper.emitir — emisión real (confirmar:true)', () => {
  it('postea el paso 4 con los campos de la previsualización y devuelve el folio', async () => {
    const { scraper, http } = armar();

    const r = await scraper.emitir(PARAMS, true);

    expect(r.emitida).toBe(true);
    expect((r as { folio: number | null }).folio).toBe(1234);
    const paso4 = (http.postForm as jest.Mock).mock.calls.find(c => (c[0] as string).includes('BoletaHonorariosElectronica'));
    expect(paso4).toBeDefined();
    expect((paso4![1] as Record<string, string>).tiempo).toBe('1787000000'); // propagado del paso 3
  });

  // El paso 4 fallando SIN confirmación NO se marca seguro: pudo emitirse.
  it('un paso 4 sin folio ni éxito es RECHAZO sin marca de seguro (mantiene la reserva)', async () => {
    const { scraper } = armar({ paso4: '<html><body>Ocurrió un problema procesando su solicitud</body></html>' });
    const err = await scraper.emitir(PARAMS, true).catch(e => e);
    expect(err).toBeInstanceOf(EscrituraRechazadaPorSii);
    expect(esSeguroDeLiberar(err)).toBe(false);
  });

  it('la sesión caída EN el paso 4 se reporta como ambigua (pudo emitirse)', async () => {
    const { scraper } = armar({ paso4: LOGIN });
    const err = await scraper.emitir(PARAMS, true).catch(e => e);
    expect(err.message).toMatch(/PUDO o no haberse emitido/);
    expect(esSeguroDeLiberar(err)).toBe(false);
  });

  // Los errores de la fase 1-3 sí van marcados seguros aunque confirmar sea true.
  it('un rechazo en la previsualización con confirmar:true queda marcado seguro', async () => {
    const { scraper } = armar({ paso3: PASO2_FORM }); // devuelve el form: rechazo
    const err = await scraper.emitir(PARAMS, true).catch(e => e);
    expect(esSeguroDeLiberar(err)).toBe(true);
  });
});
