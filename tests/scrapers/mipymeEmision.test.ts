import * as fs from 'fs';
import * as path from 'path';
import {
  MipymeHttpScraper,
  parseCamposFormulario,
  parseEmisorDesdeFormulario,
  calcularTotales,
  decodificarEntidades,
  EmitirDteParams,
} from '../../src/scrapers/mipymeHttp';
import { SiiHttpClient } from '../../src/http';
import { SessionManager } from '../../src/session';

jest.mock('../../src/http');
jest.mock('../../src/session');

const MockHttp = SiiHttpClient as jest.MockedClass<typeof SiiHttpClient>;
const MockSession = SessionManager as jest.MockedClass<typeof SessionManager>;

function fixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', nombre), 'latin1');
}

const FORM_33 = fixture('mipyme-form-emision-33.html');
const PREVIEW_33 = fixture('mipyme-preview-33.html');
const SEL_EMPRESA = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'mipyme-sel-empresa.html'),
  'utf-8'
);
const PAGINA_FIRMA = fixture('mipyme-pagina-firma.html');

// El receptor de las pruebas: RUT ficticio con DV que sí cuadra por módulo 11,
// porque la validación lo exige.
const RECEPTOR = {
  rut: '11111111',
  dv: '1',
  razonSocial: 'RECEPTORA FICTICIA S.A.',
  giro: 'SERVICIOS',
  direccion: 'CALLE FICTICIA 200',
  comuna: 'COMUNA DOS',
  ciudad: 'CIUDAD DOS',
};

function armar() {
  const session = new MockSession({} as any, {} as any);
  const http = new MockHttp(session);
  (session.conEmpresaExclusiva as jest.Mock) = jest.fn((fn: () => Promise<unknown>) => fn());
  (session.assertPuedeEntregarCookieJar as jest.Mock).mockImplementation(() => {});

  // GET: primero la selección de empresa, después el formulario de emisión.
  (http.get as jest.Mock).mockImplementation(async (url: string) =>
    url.includes('mipeGenFacEx') ? FORM_33 : SEL_EMPRESA
  );
  (http.postForm as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('mipeSelEmpresa')) return '<html>ok</html>';
    if (url.includes('mipeDisplayPreView')) return PREVIEW_33;
    // Lo que devuelve de verdad mipeGenXMLFirma.cgi: la página que pide la
    // firma con certificado, NO un documento emitido.
    return PAGINA_FIRMA;
  });

  return { scraper: new MipymeHttpScraper(http, session), http, session };
}

function params(extra: Partial<EmitirDteParams> = {}): EmitirDteParams {
  return {
    // Una de las que trae la fixture del combo de selección de empresa.
    empresaRut: '22222222-2',
    tipoDte: 33,
    receptor: RECEPTOR,
    lineas: [{ nombre: 'SERVICIO DE PRUEBA', cantidad: 1, precioUnitario: 3 }],
    ciudadEmisor: 'CIUDAD UNO',
    ...extra,
  };
}

function urlsPosteadas(http: SiiHttpClient): string[] {
  return (http.postForm as jest.Mock).mock.calls.map(c => c[0] as string);
}

describe('parseCamposFormulario', () => {
  // Este es el paso que hace posible firmar sin reconstruir el documento: la
  // previsualización trae el DTE entero en hidden y firmar es reenviarlo tal
  // cual. Si el parser pierde campos, se emite un documento distinto del que se
  // mostró.
  it('extrae los 243 hidden del form PreViewDTE de la previsualización', () => {
    const campos = parseCamposFormulario(PREVIEW_33, 'PreViewDTE');

    // Los dos botones (btnSign, btnCorregir) NO son datos del documento y no
    // los manda el navegador: 245 inputs en el HTML, 243 campos.
    expect(Object.keys(campos)).toHaveLength(243);
    expect(campos.btnSign).toBeUndefined();
    expect(campos.EFXP_MNT_NETO).toBe('3');
    expect(campos.EFXP_IVA).toBe('1');
    expect(campos.EFXP_MNT_TOTAL).toBe('4');
    expect(campos.INDICA_PRIMERA_EJECUCION).toBe('1');
  });

  it('decodifica las entidades numéricas del portal', () => {
    const campos = parseCamposFormulario(PREVIEW_33, 'PreViewDTE');

    // El SII escapa los acentos como entidades NUMÉRICAS (&#205; por la Í), no
    // con las nombradas que ya traducía `decodificar`. Reenviarlas sin
    // decodificar emite el DTE con "COMERCIAL&#205;A" literal en la razón
    // social del emisor. El correo llega igual, con &#64; por la arroba.
    expect(campos.EFXP_RZN_SOC).toBe('COMERCIALÍA FICTICIA SPA');
    expect(campos.EFXP_EMAIL_EMISOR).toBe('emisor@ejemplo.cl');
  });

  it('no confunde el form pedido con otro de la misma página', () => {
    // La página trae más de un <form> (el de navegación del portal). Pedir uno
    // por nombre tiene que devolver ese y no una mezcla.
    const campos = parseCamposFormulario(PREVIEW_33, 'PreViewDTE');
    expect(campos.PTDC_CODIGO).toBe('33');
  });

  it('falla fuerte si el form no está en la página', () => {
    // Sin form no hay documento: devolver {} haría que el paso siguiente
    // postee vacío y el error aparezca mucho más lejos de la causa. El caso
    // real es la sesión caída, que devuelve la página de login.
    expect(() => parseCamposFormulario('<html>login</html>', 'PreViewDTE')).toThrow(/PreViewDTE/);
  });
});

describe('parseEmisorDesdeFormulario', () => {
  // El formulario de emisión NO se puede leer entero del HTML: 47 <input> en el
  // HTML crudo contra 67 en el DOM, porque los <select> y varios campos los
  // dibuja JavaScript. Los datos que faltan están en arreglos JS embebidos, que
  // sí son parseables sin ejecutar nada.
  it('saca dirección, comuna y código de sucursal del arreglo JS emisorDir', () => {
    const emisor = parseEmisorDesdeFormulario(FORM_33);

    // El <input> EFXP_CDG_SII_SUCUR viene con value="" en el HTML: el código
    // real sólo está en emisorDir. Tomarlo del input manda la sucursal vacía.
    expect(emisor.codigoSucursal).toBe('11111111');
    // El portal rellena la dirección con espacios a la derecha. Se conserva tal
    // cual: el POST reenvía el valor que el propio SII entregó.
    expect(emisor.direccion).toBe('CALLE FICTICIA 100          ');
    expect(emisor.comuna).toBe('COMUNA UNO');
  });

  it('lee del HTML lo que sí está en el HTML, decodificando entidades', () => {
    const emisor = parseEmisorDesdeFormulario(FORM_33);

    expect(emisor.razonSocial).toBe('COMERCIALÍA FICTICIA SPA');
    expect(emisor.giro).toBe('GIRO DE PRUEBA SIN DATOS REALES');
    expect(emisor.acteco).toBe('702000');
    expect(emisor.email).toBe('emisor@ejemplo.cl');
  });

  it('reporta que la ciudad viene vacía en vez de inventarla', () => {
    // EFXP_CIUDAD_ORIGEN es obligatorio para el portal y aun así llega vacío.
    // El parser no lo rellena: quien emite tiene que decidir qué ciudad va, y
    // la validación exige que esté.
    expect(parseEmisorDesdeFormulario(FORM_33).ciudad).toBe('');
  });
});

describe('calcularTotales', () => {
  // Los totales los calcula el JavaScript del portal y viajan en el POST: el
  // CGI los recibe, no los recalcula. Hay que reproducir su aritmética exacta,
  // incluido el redondeo del IVA.
  it('reproduce el redondeo de IVA del portal', () => {
    // Medido en vivo contra mipeGenFacEx.cgi el 2026-08-11.
    const casos = [
      { neto: 1, iva: 0, total: 1 },
      { neto: 2, iva: 0, total: 2 },
      { neto: 3, iva: 1, total: 4 },
      { neto: 4, iva: 1, total: 5 },
      { neto: 6, iva: 1, total: 7 },
      { neto: 10, iva: 2, total: 12 },
    ];
    for (const caso of casos) {
      const t = calcularTotales([{ nombre: 'X', cantidad: 1, precioUnitario: caso.neto }]);
      expect({ neto: t.neto, iva: t.iva, total: t.total }).toEqual(caso);
    }
  });

  it('suma los subtotales de todas las líneas', () => {
    const t = calcularTotales([
      { nombre: 'A', cantidad: 2, precioUnitario: 1000 },
      { nombre: 'B', cantidad: 3, precioUnitario: 500 },
    ]);
    expect(t.subtotales).toEqual([2000, 1500]);
    expect(t.neto).toBe(3500);
    expect(t.iva).toBe(665);
    expect(t.total).toBe(4165);
  });
});

describe('MipymeHttpScraper.emitirDte', () => {
  // El test más importante del archivo: sin `confirmar`, ningún camino puede
  // llegar a mipeGenXMLFirma.cgi. Ese POST emite un documento tributario real e
  // irreversible.
  it('sin confirmar llega a la previsualización y NO firma', async () => {
    const { scraper, http } = armar();

    const resultado = await scraper.emitirDte(params());

    expect(urlsPosteadas(http).some(u => u.includes('mipeGenXMLFirma'))).toBe(false);
    expect(urlsPosteadas(http).some(u => u.includes('mipeDisplayPreView'))).toBe(true);
    expect(resultado.emitido).toBe(false);
    expect(resultado.resumen).toMatchObject({ neto: 3, iva: 1, total: 4 });
  });

  it('con confirmar reenvía los campos de la previsualización sin tocarlos', async () => {
    const { scraper, http } = armar();

    // Hoy el flujo termina en la página de firma, así que la llamada falla. Lo
    // que este test fija es QUÉ se posteó, no que la emisión se complete.
    await expect(scraper.emitirDte(params(), true)).rejects.toThrow();

    const firma = (http.postForm as jest.Mock).mock.calls.find(c =>
      (c[0] as string).includes('mipeGenXMLFirma')
    );
    expect(firma).toBeDefined();
    // Lo que se manda tiene que ser exactamente lo que el SII devolvió en la
    // previsualización: si acá se reconstruyera algo, se firmaría un documento
    // distinto del que se mostró.
    expect(firma![1]).toEqual(parseCamposFormulario(PREVIEW_33, 'PreViewDTE'));
    // Latin1, o la razón social del emisor viaja corrupta al documento.
    expect(firma![2]).toEqual({ charset: 'latin1' });
  });

  it('manda el código de sucursal que sólo estaba en el JavaScript del formulario', async () => {
    const { scraper, http } = armar();

    await scraper.emitirDte(params());

    const preview = (http.postForm as jest.Mock).mock.calls.find(c =>
      (c[0] as string).includes('mipeDisplayPreView')
    );
    expect(preview![1].EFXP_CDG_SII_SUCUR).toBe('11111111');
    expect(preview![1].EFXP_ACTECO).toBe('702000');
  });

  it('explica el rechazo por IVA 0 antes de postear, en vez de dejar que el CGI devuelva el formulario', async () => {
    const { scraper, http } = armar();

    await expect(
      scraper.emitirDte(params({ lineas: [{ nombre: 'X', cantidad: 1, precioUnitario: 1 }] }))
    ).rejects.toThrow(/IVA.*mayor a 0[\s\S]*neto mínimo emisible.*3/);

    // Y no llegó a postear nada del documento.
    expect(urlsPosteadas(http).some(u => u.includes('mipeDisplayPreView'))).toBe(false);
  });

  it('rechaza un DV de receptor que no cuadra por módulo 11', async () => {
    const { scraper } = armar();

    await expect(
      scraper.emitirDte(params({ receptor: { ...RECEPTOR, dv: '9' } }))
    ).rejects.toThrow(/RUT receptor inválido/);
  });

  it('exige la referencia en una nota de crédito', async () => {
    const { scraper } = armar();

    await expect(scraper.emitirDte(params({ tipoDte: 61 }))).rejects.toThrow(
      /nota de crédito exige al menos una referencia/
    );
  });

  it('manda el bloque de referencias con su checkbox cuando la nota de crédito lo trae', async () => {
    const { scraper, http } = armar();

    await scraper.emitirDte(
      params({
        tipoDte: 61,
        referencias: [{ tipoDoc: 33, folio: 244, fecha: '2026-08-01', razon: 'ANULA', codigo: 1 }],
      })
    );

    const preview = (http.postForm as jest.Mock).mock.calls.find(c =>
      (c[0] as string).includes('mipeDisplayPreView')
    );
    // Sin REF_SI_NO el CGI ignora los campos de referencia y emitiría una nota
    // de crédito que no dice qué documento corrige.
    expect(preview![1].REF_SI_NO).toBe('SiChecked');
    expect(preview![1].EFXP_TPO_DOC_REF_001).toBe('33');
    expect(preview![1].EFXP_FOLIO_REF_001).toBe('244');
    expect(preview![1].EFXP_CODIGO_REF_001).toBe('1');
  });

  it('pide la plantilla en blanco para la nota de crédito', async () => {
    const { scraper, http } = armar();

    await scraper.emitirDte(
      params({
        tipoDte: 61,
        referencias: [{ tipoDoc: 33, folio: 244, fecha: '2026-08-01', codigo: 1 }],
      })
    );

    const get = (http.get as jest.Mock).mock.calls.find(c => (c[0] as string).includes('mipeGenFacEx'));
    expect(get![1]).toEqual({ PTDC_CODIGO: '61', TIPO_PLANTILLA: 'NC_BLANCO' });
  });

  it('rechaza los tipos cuyo formulario no se relevó', async () => {
    const { scraper } = armar();

    await expect(scraper.emitirDte(params({ tipoDte: 52 }))).rejects.toThrow(/no está soportado/);
  });

  it('corta si el portal no devuelve la página de firma que esperaba', async () => {
    const { scraper, http } = armar();
    (http.postForm as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('mipeSelEmpresa')) return '<html>ok</html>';
      if (url.includes('mipeDisplayPreView')) return PREVIEW_33;
      return '<html>algo salió distinto</html>';
    });

    // Sin la página de firma no hay XML que firmar. Se corta ahí en vez de
    // seguir con un documento a medias: es el paso previo al que emite.
    await expect(scraper.emitirDte(params(), true)).rejects.toThrow(/no devolvió el formulario "frmSign"/);
  });

  it('corta si el portal devuelve el formulario en vez de la previsualización', async () => {
    const { scraper, http } = armar();
    (http.postForm as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('mipeSelEmpresa')) return '<html>ok</html>';
      return FORM_33;
    });

    await expect(scraper.emitirDte(params())).rejects.toThrow(/NO se emitió nada/);
  });

  it('todo el flujo va dentro de una sola sección crítica, con la empresa seleccionada antes', async () => {
    const { scraper, http, session } = armar();

    await expect(scraper.emitirDte(params(), true)).rejects.toThrow();

    // La empresa activa es estado del servidor: si la firma quedara fuera del
    // candado, otra consulta podría cambiarla entre la previsualización y la
    // firma, y se emitiría desde otro contribuyente.
    expect(session.conEmpresaExclusiva).toHaveBeenCalledTimes(1);
    const urls = urlsPosteadas(http);
    expect(urls[0]).toContain('mipeSelEmpresa');
    expect(urls[urls.length - 1]).toContain('mipeGenXMLFirma');
  });
});

describe('el rechazo del portal', () => {
  // El CGI no responde un error: devuelve una página "Redireccionando" que sólo
  // trae un alert() con el motivo y un history.go(-1). Medido en vivo: mandar
  // la fecha vacía devuelve exactamente esto. Quedarse con el <title> reporta
  // "devolvió Redireccionando", que manda a investigar la sesión cuando lo que
  // faltaba era un campo.
  const RECHAZO = `<HTML><HEAD><TITLE>Redireccionando</TITLE>
    <script type='text/javascript'>
    function redirec() { alert('Debe ingresar el campo : Fecha emision\\n'); window.history.go(-1); }
    </script></head><body onLoad='redirec()'></body></html>`;

  it('reporta el motivo que el portal escondió en el alert', async () => {
    const { scraper, http } = armar();
    (http.postForm as jest.Mock).mockImplementation(async (url: string) =>
      url.includes('mipeSelEmpresa') ? '<html>ok</html>' : RECHAZO
    );

    await expect(scraper.emitirDte(params())).rejects.toThrow(
      /Debe ingresar el campo : Fecha emision.*NO se emitió nada/s
    );
  });
});

describe('parseEmisorDesdeFormulario: la fecha', () => {
  it('la toma del arreglo arrFecha, porque el <input type="date"> viene vacío', () => {
    // Con la fecha vacía el CGI rechaza el documento. Es la fecha del servidor
    // del SII, no la del reloj local.
    expect(parseEmisorDesdeFormulario(FORM_33).fechaEmision).toBe('2026-08-11');
  });
});


// Los tres pasos finales, que son los que emiten de verdad. `mipeGenXMLFirma`
// engaña por el nombre: no emite, arma el XML y pide la firma. Medido en vivo el
// 2026-08-11 — y ese malentendido costó un falso positivo: una versión anterior
// leía el folio de esa página y devolvía "emitido, folio 21" mientras el
// historial del portal seguía en el 20. Un folio en la respuesta no prueba que
// el documento exista.
describe('MipymeHttpScraper.emitirDte: firma y envío', () => {
  const XML_FIRMADO = '<?xml version="1.0"?><DTE><Documento/><Signature>...</Signature></DTE>';

  function armarConFirma(overrides: {
    certs?: string;
    firmado?: string;
    envio?: string;
  } = {}) {
    const ctx = armar();
    (ctx.session.identidad as jest.Mock) = jest.fn(() => ({ rut: '11111111', dv: '1' }));
    (ctx.session.claveCertificadoSii as jest.Mock) = jest.fn(() => 'clave-del-certificado');

    (ctx.http.get as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('getCertDigital')) {
        return overrides.certs ?? '[{"nombre":"1","rut":11111111,"dv":"1"}]';
      }
      return url.includes('mipeGenFacEx') ? FORM_33 : SEL_EMPRESA;
    });
    (ctx.http.postForm as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('mipeSelEmpresa')) return '<html>ok</html>';
      if (url.includes('mipeDisplayPreView')) return PREVIEW_33;
      if (url.includes('mipeGenXMLFirma')) return PAGINA_FIRMA;
      if (url.includes('postFirmaDigital')) return overrides.firmado ?? XML_FIRMADO;
      return overrides.envio ?? '<html><body>Documento enviado</body></html>';
    });
    return ctx;
  }

  it('firma el XML con el certificado del SII y lo envía, devolviendo el folio', async () => {
    const { scraper, http } = armarConFirma();

    const resultado = await scraper.emitirDte(params(), true);

    expect(resultado).toMatchObject({ emitido: true, folio: 22 });

    // El XML que se firma es el que armó el SII, no uno reconstruido acá.
    const firma = (http.postForm as jest.Mock).mock.calls.find(c =>
      (c[0] as string).includes('postFirmaDigital')
    );
    expect(firma![1].dato).toContain('<TipoDTE>33</TipoDTE>');
    expect(firma![1].nombre).toBe('1');
    expect(firma![1].nodo).toBe('dte:DTE');
    expect(firma![1].nodoId).toBe('dte:Documento');
    expect(firma![1].nameSpace).toBe('http://www.sii.cl/SiiDte');

    // Y lo que se envía lleva la firma en txtSignText.
    const envio = (http.postForm as jest.Mock).mock.calls.find(c =>
      (c[0] as string).includes('mipeSendXML')
    );
    expect(envio![1].txtSignText).toBe(XML_FIRMADO);
    expect(envio![1].EFXP_FOLIO).toBe('22');
  });

  it('la clave del certificado sale de la sesión, nunca de los parámetros de la tool', async () => {
    const { scraper, http, session } = armarConFirma();

    await scraper.emitirDte(params(), true);

    expect(session.claveCertificadoSii).toHaveBeenCalled();
    const firma = (http.postForm as jest.Mock).mock.calls.find(c =>
      (c[0] as string).includes('postFirmaDigital')
    );
    expect(firma![1].clave).toBe('clave-del-certificado');
  });

  it('no envía nada si el SII no devolvió un XML firmado', async () => {
    // Enviar la respuesta de error como si fuera el documento mandaría basura al
    // SII en lugar de un DTE.
    const { scraper, http } = armarConFirma({ firmado: 'clave incorrecta' });

    await expect(scraper.emitirDte(params(), true)).rejects.toThrow(/no firmó[\s\S]*NO se emitió nada/);
    expect(urlsPosteadas(http).some(u => u.includes('mipeSendXML'))).toBe(false);
  });

  it('explica el caso sin certificado centralizado en vez de fallar en el paso siguiente', async () => {
    // Sin certificado cargado en el SII, la única modalidad que queda es el
    // plug-in del navegador, que no se puede replicar por HTTP.
    const { scraper, http } = armarConFirma({ certs: '[]' });

    await expect(scraper.emitirDte(params(), true)).rejects.toThrow(
      /no tiene un certificado digital cargado en el SII[\s\S]*NO se emitió nada/
    );
    expect(urlsPosteadas(http).some(u => u.includes('postFirmaDigital'))).toBe(false);
  });

  it('no da por emitido un documento cuando el portal rechazó el envío', async () => {
    const { scraper } = armarConFirma({
      envio: `<html><script>function redirec(){ alert('Error al enviar el documento'); }</script></html>`,
    });

    await expect(scraper.emitirDte(params(), true)).rejects.toThrow(/rechazó el envío.*Error al enviar/);
  });

  it('no da por emitido cuando el portal vuelve a pedir la firma', async () => {
    const { scraper } = armarConFirma({ envio: PAGINA_FIRMA });

    await expect(scraper.emitirDte(params(), true)).rejects.toThrow(/NO se emitió/);
  });

  it('exige la clave configurada antes de tocar el certificado', async () => {
    const ctx = armarConFirma();
    (ctx.session.claveCertificadoSii as jest.Mock) = jest.fn(() => undefined);

    await expect(ctx.scraper.emitirDte(params(), true)).rejects.toThrow(/SII_CERT_CLAVE_SII/);
    // Y falla sin consultar el certificado: la consulta habría terminado en el
    // mismo error, una llamada a la red más tarde.
    expect((ctx.http.get as jest.Mock).mock.calls.some(c => (c[0] as string).includes('getCertDigital'))).toBe(false);
  });
});

describe('la clave del certificado del SII', () => {
  // El certificado cargado en el SII y el .p12 de SII_CERT_PATH son dos cosas
  // distintas: pueden ser archivos distintos, o el mismo cargado con otra
  // clave. Derivar una de la otra no sólo falla — manda un secreto que no
  // corresponde a un endpoint que no lo pidió.
  it('no se sustituye por la del certificado local: falla pidiéndola', async () => {
    const ctx = armar();
    (ctx.session.claveCertificadoSii as jest.Mock) = jest.fn(() => undefined);
    (ctx.session.identidad as jest.Mock) = jest.fn(() => ({ rut: '11111111', dv: '1' }));

    await expect(ctx.scraper.emitirDte(params(), true)).rejects.toThrow(
      /SII_CERT_CLAVE_SII[\s\S]*certificado local/
    );

    // Y no se posteó ninguna firma, así que ninguna clave salió del proceso.
    expect(urlsPosteadas(ctx.http).some(u => u.includes('postFirmaDigital'))).toBe(false);
  });
});

describe('MipymeHttpScraper.verificarFirma', () => {
  // Comprobar que SII_CERT_CLAVE_SII sirve, SIN emitir. Se puede porque
  // postFirmaDigital.cgi firma pero no emite: el que emite es el POST
  // siguiente, mipeSendXML.cgi. Sin esto, la única forma de saber si la clave
  // es la correcta sería emitir un documento tributario real.
  function armarVerificacion(overrides: { certs?: string; firmado?: string } = {}) {
    const ctx = armar();
    (ctx.session.identidad as jest.Mock) = jest.fn(() => ({ rut: '11111111', dv: '1' }));
    (ctx.session.claveCertificadoSii as jest.Mock) = jest.fn(() => 'clave-del-certificado');
    (ctx.http.get as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('getCertDigital')) return overrides.certs ?? '[{"nombre":"1"}]';
      return url.includes('mipeGenFacEx') ? FORM_33 : SEL_EMPRESA;
    });
    (ctx.http.postForm as jest.Mock).mockImplementation(async (url: string) => {
      if (url.includes('mipeSelEmpresa')) return '<html>ok</html>';
      if (url.includes('mipeDisplayPreView')) return PREVIEW_33;
      if (url.includes('mipeGenXMLFirma')) return PAGINA_FIRMA;
      if (url.includes('postFirmaDigital')) {
        return overrides.firmado ?? '<DTE><Documento/><Signature>...</Signature></DTE>';
      }
      throw new Error(`no debería postearse a ${url}`);
    });
    return ctx;
  }

  it('confirma que la clave sirve sin emitir el documento', async () => {
    const { scraper, http } = armarVerificacion();

    const resultado = await scraper.verificarFirma(params());

    expect(resultado).toMatchObject({ firmaValida: true, certId: '1' });
    // Lo que hace útil a esta verificación: NO llega al paso que emite.
    expect(urlsPosteadas(http).some(u => u.includes('mipeSendXML'))).toBe(false);
  });

  it('informa la clave incorrecta en vez de lanzar, para que se pueda diagnosticar', async () => {
    const { scraper, http } = armarVerificacion({ firmado: 'Error: clave incorrecta' });

    const resultado = await scraper.verificarFirma(params());

    expect(resultado.firmaValida).toBe(false);
    expect(resultado.detalle).toContain('clave incorrecta');
    expect(urlsPosteadas(http).some(u => u.includes('mipeSendXML'))).toBe(false);
  });

  it('nunca postea al endpoint que emite, ni siquiera cuando todo sale bien', async () => {
    const { scraper, http } = armarVerificacion();

    await scraper.verificarFirma(params());

    // El mock lanza si alguien postea a una URL inesperada; este assert deja el
    // contrato explícito igual, porque es la garantía entera de esta función.
    const urls = urlsPosteadas(http);
    expect(urls).toEqual([
      expect.stringContaining('mipeSelEmpresa'),
      expect.stringContaining('mipeDisplayPreView'),
      expect.stringContaining('mipeGenXMLFirma'),
      expect.stringContaining('postFirmaDigital'),
    ]);
  });
});

describe('decodificarEntidades', () => {
  it('decodifica entidades numéricas y nombradas', () => {
    expect(decodificarEntidades('COMERCIAL&#205;A')).toBe('COMERCIALÍA');
    expect(decodificarEntidades('a&aacute;o')).toBe('aáo');
    expect(decodificarEntidades('correo&#64;ejemplo.cl')).toBe('correo@ejemplo.cl');
  });

  it('no decodifica dos veces: &amp; se resuelve ÚLTIMO', () => {
    // El SII escapa un `&` literal como `&amp;`. Si `&amp;` se resolviera antes
    // que las entidades, un `&amp;#205;` escrito así por el portal quedaría como
    // `&#205;` y la pasada siguiente lo convertiría en `Í` — decodificando dos
    // veces un dato que el SII mandó escapado a propósito. El orden lo evita.
    expect(decodificarEntidades('AT&amp;T')).toBe('AT&T');
    expect(decodificarEntidades('AT&amp;#205;T')).toBe('AT&#205;T');
  });
});
