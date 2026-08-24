import { SessionManager } from '../src/session';
import { Browser } from '../src/browser';
import { AuthStrategy, SiiConfig } from '../src/env';

jest.mock('../src/browser');
const MockBrowser = Browser as jest.MockedClass<typeof Browser>;

// Tanto el polling de credenciales (assertLoginPorClaveExitoso) como el del
// formulario (esperarFormularioDeLogin) duermen con setTimeout real (no
// bloqueante, no execSync) — con fake timers global + runAllTimersAsync,
// cualquier test que los dispare (éxito con URLs sucesivas, rechazo agotando
// 15s, o el formulario que nunca aparece agotando 20s) avanza sin pagar
// tiempo real.
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// El mock de child_process abajo neutraliza el execSync/execFileSync
// SINCRÓNICO que usan otros caminos (openssl/curl del login por certificado),
// no el polling (que usa setTimeout, ver arriba).
jest.mock('child_process', () => ({
  execSync: jest.fn(() => ''),
  execFileSync: jest.fn(() => ''),
}));

async function conTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promesa = fn();
  // Si `promesa` rechaza mientras runAllTimersAsync todavía está resolviendo
  // timers pendientes, todavía no hay ningún handler adjunto a ella (recién
  // se adjunta al hacer `return promesa` más abajo) — Node lo marca como
  // rejection no manejada, aunque termine manejándose un instante después.
  // Este catch mudo la marca como manejada de inmediato sin alterar el
  // resultado real que ve quien llama a conTimers().
  promesa.catch(() => {});
  await jest.runAllTimersAsync();
  return promesa;
}

// Cookies que el SII sólo emite cuando el login autenticó de verdad. Son la
// evidencia en la que se basa el chequeo de éxito (ver comentario en
// assertLoginPorClaveExitoso): la URL no sirve, porque un rechazo por clave
// incorrecta también sale del formulario y sigue en sii.cl.
const COOKIES_CON_SESION = ['TS0161cd2b', 'TOKEN', 'CSESSIONID', 'RUT_NS', 'DV_NS'];
// Lo único que queda tras un login rechazado: el WAF y la cola de espera.
const COOKIES_SIN_SESION = ['TS0161cd2b', 'QueueITAccepted-SDFrts345E-V3_autenticacionmisii'];

// Las mismas, con la ubicación que reporta el CLI: es lo que se necesita para
// borrarlas donde viven de verdad.
const ubicadas = (nombres: string[]) =>
  nombres.map(name => ({ name, domain: '.sii.cl', path: '/', tieneValor: true }));

// Simula el jar del contexto: `borrarCookies` quita de verdad lo que se le pide.
// Es necesario, no cosmético — loginConClave VERIFICA el borrado y aborta si
// quedó alguna cookie de sesión viva, así que un mock que devuelva siempre lo
// mismo haría fallar todo login.
function conJarSimulado(browser: Browser, inicial: string[], trasElSubmit = inicial): void {
  let jar = ubicadas(inicial);
  (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => jar);
  (browser.borrarCookies as jest.Mock).mockImplementation((aBorrar: Array<{ name: string }>) => {
    const nombres = new Set(aBorrar.map(c => c.name));
    jar = jar.filter(c => !nombres.has(c.name));
  });
  // El SII repone las cookies al autenticar; el mock lo hace cuando ve el
  // requestSubmit, que es el momento en que el portal procesa el login.
  const evalPrevio = (browser.eval as jest.Mock).getMockImplementation();
  (browser.eval as jest.Mock).mockImplementation((js: string) => {
    if (js.includes('requestSubmit')) jar = ubicadas(trasElSubmit);
    return evalPrevio ? evalPrevio(js) : '';
  });
}

function crearBrowserMock(): Browser {
  const browser = new MockBrowser();
  // Default: el login autentica. El éxito se decide por las cookies de sesión
  // del SII (ver assertLoginPorClaveExitoso), así que sin este mock TODO login
  // fallaría; los tests de rechazo lo sobreescriben con COOKIES_SIN_SESION.
  conJarSimulado(browser, COOKIES_CON_SESION);
  return browser;
}

const configClave: SiiConfig = {
  rut: '12345678',
  strategy: AuthStrategy.Clave,
  clave: 'mipass',
};

// Snapshot del portal mipyme con una sola empresa (formato "NOMBRE RUT-DV")
const empresaUnicaSnapshot = [
  '- combobox [expanded=false, ref=e10]: Empresa',
  '- option "EMPRESA UNO SPA 11111111-1" [ref=e11]',
].join('\n');

// Snapshot con dos empresas
const dosEmpresasSnapshot = [
  '- combobox [expanded=false, ref=e10]: Empresa',
  '- option "EMPRESA UNO SPA 11111111-1" [ref=e11]',
  '- option "EMPRESA DOS LTDA 22222222-2" [ref=e12]',
].join('\n');

// El nuevo login llena y envía el form por `eval`, no por fill/click. El
// mismo método `eval` sirve para tres cosas distintas (chequear si apareció
// myform, llenar los campos, hacer requestSubmit), así que el mock inspecciona
// el JS recibido en vez de devolver un valor fijo — igual que hace el propio
// SessionManager con la respuesta real del navegador.
function mockearEvalFormulario(browser: Browser, formularioAparece = true): void {
  (browser.eval as jest.Mock).mockImplementation((js: string) => {
    if (js.includes("getElementById('myform')") && js.includes('SI')) {
      return formularioAparece ? 'SI' : 'NO';
    }
    return '';
  });
}

// Login por clave exitoso: el formulario aparece y el contexto queda con las
// cookies de sesión del SII.
function mockearLoginExitoso(
  browser: Browser,
  snapshotEmpresa: string,
  urlFinal = 'https://mipyme.sii.cl/'
): void {
  mockearEvalFormulario(browser, true);
  (browser.getUrl as jest.Mock).mockReturnValue(urlFinal);
  conJarSimulado(browser, COOKIES_CON_SESION);
  (browser.snapshot as jest.Mock).mockReturnValue(snapshotEmpresa);
}

describe('SessionManager.login', () => {
  it('navega a la puerta de entrada del portal privado, no al form directo', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    // El form de login no rinde si se navega a él directo (about:blank): hay
    // que llegar por redirect desde una página privada del portal.
    expect(browser.open).toHaveBeenCalledWith('https://misiir.sii.cl/cgi_misii/siihome.cgi');
  });

  it('llena el form por JS y lo envía con requestSubmit, no con un click', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    const evals = (browser.eval as jest.Mock).mock.calls.map(([js]) => js as string);
    // El llenado de campos (lleva la clave tributaria) va por evalPrivado, NO
    // por eval: evalPrivado manda el JS por stdin de agent-browser en vez de
    // por argv, para que la clave no quede visible en ps/cmdline.
    const evalsPrivados = (browser.evalPrivado as jest.Mock).mock.calls.map(([js]) => js as string);
    expect(evalsPrivados.some(js => js.includes("getElementById('clave').value"))).toBe(true);
    expect(evals.some(js => js.includes("getElementById('clave').value"))).toBe(false);
    // Un click sintético en el botón no dispara el onsubmit del form: hay que
    // usar requestSubmit().
    expect(evals.some(js => js.includes('requestSubmit'))).toBe(true);
    expect(browser.click).not.toHaveBeenCalled();
  });

  it('si el formulario nunca aparece, lanza un error distinto al de credenciales', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, false);

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow(
      'El SII no mostró el formulario de autenticación'
    );
  });

  it('éxito: la URL final sale del login y cae en un dominio sii.cl, no lanza', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot, 'https://misiir.sii.cl/cgi_misii/siihome.cgi');

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).resolves.toBeDefined();
  });

  it('selecciona empresa por SII_EMPRESA_RUT si hay multiples', async () => {
    const config = { ...configClave, empresaRut: '11111111-1' };
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    await conTimers(() => mgr.login());

    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '11111111-1');
  });

  it('lanza error accionable si hay multiples empresas y no hay SII_EMPRESA_RUT', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await expect(conTimers(() => mgr.login())).rejects.toThrow('SII_EMPRESA_RUT');
  });

  // REGRESIÓN, verificada contra el portal real: con una clave incorrecta el
  // SII postea a CAutInicio.cgi y renderiza ahí "La Clave Tributaria ingresada
  // no es correcta". Esa URL NO contiene IngresoRutClave y SÍ es sii.cl, así
  // que el criterio anterior (basado en la URL) la daba por éxito: validar-clave
  // respondía ok:true con cualquier clave y el gate de Tributy no protegía nada.
  it('clave rechazada en CAutInicio.cgi: sin cookies de sesión, lanza error clasificable', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi');
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockReturnValue(ubicadas(COOKIES_SIN_SESION));
    (browser.eval as jest.Mock).mockImplementation((js: string) =>
      js.includes('innerText')
        ? 'La Clave Tributaria ingresada no es correcta, verifique que su teclado...'
        : 'SI'
    );

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });

  // El contexto de agent-browser PERSISTE entre invocaciones (`--session <rut>`)
  // y logout() sólo navega a la URL de término. Sin limpiar las cookies antes de
  // intentar el login, una TOKEN de un login anterior haría que una clave
  // incorrecta se reporte como válida: el mismo falso positivo, por otra puerta.
  it('limpia las cookies antes de enviar el formulario, para no ver una sesión vieja', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    expect(browser.borrarCookies).toHaveBeenCalled();
    // Sólo las de sesión del SII, no todo el jar: ahí viven el token del WAF y
    // el de la cola de espera, y tirarlos re-encola cada login.
    const [aBorrar] = (browser.borrarCookies as jest.Mock).mock.calls[0];
    const nombres = (aBorrar as Array<{ name: string }>).map(c => c.name);
    expect(nombres).toContain('TOKEN');
    expect(nombres).toContain('CSESSIONID');
    // Y el token del WAF sobrevive: borrarlo re-encola cada login.
    expect(nombres).not.toContain('TS0161cd2b');
    // Y antes de navegar al portal, no después de autenticar (que borraría la
    // sesión recién obtenida).
    const ordenLimpiar = (browser.borrarCookies as jest.Mock).mock.invocationCallOrder[0];
    const ordenOpen = (browser.open as jest.Mock).mock.invocationCallOrder[0];
    expect(ordenLimpiar).toBeLessThan(ordenOpen);
  });

  // El diseño es allowlist inversa: se va todo lo del SII salvo WAF y cola.
  // Nadie más atrapa una regresión que vacíe el jar completo, que re-encolaría
  // cada login y puede hacer fallar uno con credenciales válidas.
  it('no borra las cookies del WAF ni de la cola de espera', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    (browser.snapshot as jest.Mock).mockReturnValue(empresaUnicaSnapshot);
    conJarSimulado(browser, [
      'TOKEN', 'TS0161cd2b', 'QueueITAccepted-SDFrts345E-V3_autenticacionmisii',
    ]);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    const [aBorrar] = (browser.borrarCookies as jest.Mock).mock.calls[0];
    expect((aBorrar as Array<{ name: string }>).map(c => c.name)).toEqual(['TOKEN']);
  });

  // Con un prefijo laxo (`/^TS[0-9a-f]/`), `TSESSION` contaría como
  // infraestructura —la `e` es hex— y sobreviviría al borrado: justo el residuo
  // de sesión que todo esto existe para evitar.
  it('no confunde una cookie de sesión con el token del WAF por el prefijo TS', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    (browser.snapshot as jest.Mock).mockReturnValue(empresaUnicaSnapshot);
    conJarSimulado(browser, [
      'TOKEN', 'TSESSION', 'TSAuth',
      // Las tres formas que emite F5. Si alguna se borrara, cada login volvería
      // a la cola o al challenge del WAF, en silencio.
      'TS0161cd2b', 'TS01a1b2c3_28', 'TSPD_101',
    ]);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    const [aBorrar] = (browser.borrarCookies as jest.Mock).mock.calls[0];
    const nombres = (aBorrar as Array<{ name: string }>).map(c => c.name);
    expect(nombres).toEqual(expect.arrayContaining(['TOKEN', 'TSESSION', 'TSAuth']));
    expect(nombres).not.toContain('TS0161cd2b');
    expect(nombres).not.toContain('TS01a1b2c3_28');
    expect(nombres).not.toContain('TSPD_101');
  });

  // El mensaje del portal puede cambiar de copy; el código de mensaje que
  // imprime debajo es la señal estable del mismo caso.
  it('reconoce la clave incorrecta por el código de mensaje, sin el texto', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi');
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockReturnValue(ubicadas(COOKIES_SIN_SESION));
    (browser.eval as jest.Mock).mockImplementation((js: string) => {
      if (js.includes('innerText')) return 'El código de este mensaje es 01.01.217.500.720.20';
      return js.includes("getElementById('myform')") && js.includes('SI') ? 'SI' : '';
    });

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });

  // Si no se puede limpiar, no se puede confiar en las cookies que aparezcan
  // después: se corta antes de intentar, con un mensaje propio.
  it('si no puede limpiar la sesión previa, no intenta el login', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => {
      throw new Error('respuesta no parseable del CLI');
    });

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow(/no se pudo limpiar la sesión anterior/i);
    expect(browser.open).not.toHaveBeenCalled();
  });

  // El contexto es persistente por RUT: una cookie de sesión que el borrado
  // selectivo no logre sacar dejaría a ese RUT sin poder autenticar nunca más,
  // ni con la clave correcta. Vaciar el jar cuesta re-encolarse una vez; quedar
  // bloqueado no tiene salida.
  it('si el borrado selectivo no saca la sesión, vacía el jar completo y sigue', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    (browser.snapshot as jest.Mock).mockReturnValue(empresaUnicaSnapshot);

    // El borrado selectivo no logra sacar TOKEN (atributos que no matchean);
    // sólo el vaciado total lo consigue.
    let jar = ubicadas(['TOKEN']);
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => jar);
    (browser.borrarCookies as jest.Mock).mockReturnValue(0);
    (browser.vaciarCookies as jest.Mock).mockImplementation(() => { jar = []; });
    const evalFormulario = (browser.eval as jest.Mock).getMockImplementation()!;
    (browser.eval as jest.Mock).mockImplementation((js: string) => {
      if (js.includes('requestSubmit')) jar = ubicadas(['TOKEN', 'CSESSIONID']);
      return evalFormulario(js);
    });

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login());

    expect(browser.vaciarCookies).toHaveBeenCalled();
  });

  it('si ni vaciar el jar saca la sesión, ahí sí aborta', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    // TOKEN sobrevive a todo: no hay forma de confiar en el chequeo posterior.
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockReturnValue(ubicadas(['TOKEN']));
    (browser.borrarCookies as jest.Mock).mockReturnValue(0);

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow(/no se pudo limpiar la sesión anterior/i);
    expect(browser.vaciarCookies).toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });

  // El escenario completo del bug, no sólo el orden de las llamadas: el contexto
  // ya traía TOKEN de un login anterior y la clave de ahora es incorrecta. Sin
  // el borrado previo, el primer poll vería esa cookie vieja y reportaría
  // ok:true. Si alguien mueve el borrado a logout(), este test se cae.
  it('con un TOKEN viejo en el contexto, una clave incorrecta se rechaza igual', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi');

    // El contexto arranca con la sesión anterior puesta y sólo queda sin ella
    // después de que loginConClave la borre.
    let cookies = COOKIES_CON_SESION;
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => ubicadas(cookies));
    (browser.borrarCookies as jest.Mock).mockImplementation(() => { cookies = COOKIES_SIN_SESION; });
    
    (browser.eval as jest.Mock).mockImplementation((js: string) => {
      if (js.includes('innerText')) return 'La Clave Tributaria ingresada no es correcta';
      return js.includes("getElementById('myform')") && js.includes('SI') ? 'SI' : '';
    });

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });

  // Login lento pero exitoso: las cookies todavía no están en los primeros
  // polls (el SII sigue procesando el submit) y aparecen en uno posterior. No
  // debe clasificarse como rechazo sólo porque no estaban al principio.
  it('clave válida con login lento: las cookies aparecen en un poll posterior', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    // El submit deja el jar sin sesión y sólo la tercera lectura la ve: simula
    // al SII procesando el login más lento que el primer poll.
    conJarSimulado(browser, COOKIES_CON_SESION, COOKIES_SIN_SESION);
    let lecturas = 0;
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => {
      lecturas += 1;
      // Las dos primeras lecturas del poll (la del borrado no cuenta) todavía no
      // ven la sesión.
      return lecturas <= 3 ? ubicadas(COOKIES_SIN_SESION) : ubicadas(COOKIES_CON_SESION);
    });
    (browser.snapshot as jest.Mock).mockReturnValue(empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    const session = await conTimers(() => mgr.login());

    expect(session.empresaRut).toBe('11111111-1');
  });

  // Sin sesión y sin el mensaje de clave incorrecta no se puede afirmar que la
  // credencial esté mal: puede ser la cola de espera, una caída o un bloqueo
  // temporal. Se rechaza igual, pero con un mensaje que NO clasifica como
  // credencial inválida — si no, el tenant borraría una clave que sí servía.
  // Cada lectura spawnea un proceso `agent-browser cookies get`. Con paso fijo
  // de 1s, agotar los 15s costaba 15 polls; con backoff capado en 2s son 8
  // (1+2+2+2+2+2+2+2 = 15s), más las 2 de la limpieza previa: 10 en total. Sin
  // este test, un `step *= 2` mal editado vuelve a las 15 sin que nada se caiga.
  it('el poll usa backoff: agotar el tiempo cuesta 10 lecturas, no 17', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi');
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockReturnValue(ubicadas(COOKIES_SIN_SESION));

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.login()).catch(() => {});

    expect((browser.cookiesDelSiiConUbicacion as jest.Mock).mock.calls.length).toBe(10);
  });

  // El rechazo por clave incorrecta es definitivo: esperar los 15s completos
  // regala tiempo en un endpoint síncrono, y si el portal navega en el medio el
  // mensaje desaparece y el fallo se reportaría como transitorio.
  it('corta en el primer poll cuando el portal ya dijo que la clave es incorrecta', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    conJarSimulado(browser, COOKIES_SIN_SESION);
    const evalFormulario = (browser.eval as jest.Mock).getMockImplementation()!;
    (browser.eval as jest.Mock).mockImplementation((js: string) =>
      js.includes('innerText')
        ? 'La Clave Tributaria ingresada no es correcta'
        : evalFormulario(js)
    );

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
    // Una sola vuelta del poll (más las 2 lecturas de la limpieza previa), no las 8.
    expect((browser.cookiesDelSiiConUbicacion as jest.Mock).mock.calls.length).toBe(3);
  });

  // La URL es sólo para el log: si su lectura falla, la clasificación no puede
  // degradarse a ERROR — el tenant guardaría una clave inválida por un fallo de
  // logging.
  it('clasifica la clave incorrecta aunque falle la lectura de la URL', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    conJarSimulado(browser, COOKIES_SIN_SESION);
    (browser.getUrl as jest.Mock).mockImplementation(() => {
      throw new Error('agent-browser falló al ejecutar get');
    });
    const evalFormulario = (browser.eval as jest.Mock).getMockImplementation()!;
    (browser.eval as jest.Mock).mockImplementation((js: string) =>
      js.includes('innerText')
        ? 'La Clave Tributaria ingresada no es correcta'
        : evalFormulario(js)
    );

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.login())).rejects.toThrow('El SII rechazó la autenticación');
  });

  it('sin cookies y sin motivo reconocible: rechaza sin culpar a la credencial', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi');
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockReturnValue(ubicadas(COOKIES_SIN_SESION));
    (browser.eval as jest.Mock).mockImplementation((js: string) =>
      js.includes('innerText') ? 'Servicio temporalmente no disponible' : 'SI'
    );

    const mgr = new SessionManager(configClave, browser);

    const error = await conTimers(() => mgr.login()).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/no estableció una sesión/);
    expect((error as Error).message).not.toMatch(/rechazó la autenticación/);
  });

  // La lectura de cookies es la única evidencia de éxito: si el CLI devuelve
  // algo ilegible, eso NO es "no hay sesión" — pero tampoco alcanza para
  // afirmar que hay. Se rechaza, y el mensaje dice que no se pudo verificar en
  // vez de culpar a la credencial (que puede ser perfectamente válida).
  it('si no se pueden leer las cookies, no da el login por bueno ni culpa a la clave', async () => {
    const browser = crearBrowserMock();
    mockearEvalFormulario(browser, true);
    (browser.getUrl as jest.Mock).mockReturnValue('https://mipyme.sii.cl/');
    // La limpieza previa funciona (primeras dos lecturas) y la lectura falla
    // recién después, al verificar si el login estableció la sesión.
    let lecturas = 0;
    (browser.cookiesDelSiiConUbicacion as jest.Mock).mockImplementation(() => {
      lecturas += 1;
      if (lecturas <= 2) return [];
      throw new Error('respuesta no parseable del CLI');
    });

    const mgr = new SessionManager(configClave, browser);

    const error = await conTimers(() => mgr.login()).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/No se pudo verificar/);
    expect((error as Error).message).not.toMatch(/rechazó la autenticación/);
  });
});

describe('SessionManager.getSession', () => {
  it('reutiliza la sesion cacheada sin hacer login nuevamente', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    await conTimers(() => mgr.getSession());
    await conTimers(() => mgr.getSession());

    // login abre SII_PORTAL_PRIVADO + selectEmpresa abre SII_SEL_EMPRESA_URL = 2 calls en total.
    // El segundo getSession() usa la caché y no llama open.
    expect(browser.open).toHaveBeenCalledTimes(2);
  });

  // El parámetro por llamada es la máxima prioridad: es la intención explícita
  // de quien invoca la tool, así que debe ganarle incluso a SII_EMPRESA_RUT.
  it('con varias empresas, resuelve por el empresaRut del parámetro aunque no haya SII_EMPRESA_RUT', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);
    const session = await conTimers(() => mgr.getSession('22222222-2'));

    expect(session.empresaRut).toBe('22222222-2');
    expect(browser.select).toHaveBeenCalledWith(expect.any(String), '22222222-2');
  });

  it('con varias empresas, resuelve por SII_EMPRESA_RUT si no viene el parámetro', async () => {
    const config = { ...configClave, empresaRut: '22222222-2' };
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    const session = await conTimers(() => mgr.getSession());

    expect(session.empresaRut).toBe('22222222-2');
  });

  it('con varias empresas y ninguna resolución disponible, el error lista las empresas y menciona ambas salidas', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(configClave, browser);

    let mensaje = '';
    try {
      await conTimers(() => mgr.getSession());
    } catch (err) {
      mensaje = err instanceof Error ? err.message : String(err);
    }

    expect(mensaje).toMatch(/empresa_rut/);
    expect(mensaje).toMatch(/SII_EMPRESA_RUT/);
    expect(mensaje).toMatch(/11111111-1 — EMPRESA UNO SPA/);
    expect(mensaje).toMatch(/22222222-2 — EMPRESA DOS LTDA/);
  });

  it('con una sola empresa y nada configurado, resuelve sin pedir nada', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);
    const session = await conTimers(() => mgr.getSession());

    expect(session.empresaRut).toBe('11111111-1');
  });

  // La rama de varias empresas valida que el RUT pedido esté en la lista; la
  // rama de una sola empresa seleccionaba lo que hubiera sin comparar contra
  // el RUT pedido. Con una única empresa disponible y un empresa_rut
  // explícito que no coincide, debe fallar igual que la rama multi — no
  // quedar seleccionada en la empresa equivocada devolviendo datos que
  // parecen buenos.
  it('con una sola empresa disponible, rechaza un empresaRut pedido que no coincide', async () => {
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, empresaUnicaSnapshot);

    const mgr = new SessionManager(configClave, browser);

    await expect(conTimers(() => mgr.getSession('22222222-2'))).rejects.toThrow(/no encontrada/);
    // Nunca debe seleccionar la empresa 1 como si fuera la 2 pedida.
    expect(browser.select).not.toHaveBeenCalledWith(expect.any(String), '11111111-1');
  });

  // selectEmpresa() debe esperar los mismos marcadores que
  // listEmpresasDisponibles() antes de leer el combo. Sin esa espera, un
  // render lento deja el snapshot sin opciones y, si hay una empresa
  // preferida configurada, se fabricaría una sesión "seleccionada" sin haber
  // tocado el navegador — y quedaría cacheada como válida para siempre.
  it('si la página de selección no rindió, falla en vez de fabricar una sesión', async () => {
    const config = { ...configClave, empresaRut: '11111111-1' };
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, '- generic\n  - StaticText "Cargando"');

    const mgr = new SessionManager(config, browser);

    await expect(conTimers(() => mgr.getSession())).rejects.toThrow(/no terminó de cargar/);
    expect(browser.select).not.toHaveBeenCalled();
  });

  // Pedir otra empresa mientras hay sesión cacheada debe cambiar de empresa sin
  // reautenticar: una segunda autenticación del mismo RUT dispara el bloqueo
  // del SII (01.01.190.500.720.27).
  it('pedir una empresa distinta a la cacheada cambia de empresa sin reautenticar', async () => {
    const config = { ...configClave, empresaRut: '11111111-1' };
    const browser = crearBrowserMock();
    mockearLoginExitoso(browser, dosEmpresasSnapshot);

    const mgr = new SessionManager(config, browser);
    await conTimers(() => mgr.getSession()); // login inicial, empresa 1

    const loginOpensAntes = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave|siihome/.test(url)).length;

    const session = await conTimers(() => mgr.getSession('22222222-2'));

    const loginOpensDespues = (browser.open as jest.Mock).mock.calls
      .filter(([url]) => /IngresoRutClave|siihome/.test(url)).length;

    expect(session.empresaRut).toBe('22222222-2');
    expect(loginOpensDespues).toBe(loginOpensAntes); // ninguna autenticación nueva
  });
});

describe('SessionManager.obtenerBrowser', () => {
  it('devuelve el Browser con el que se construyó la sesión', () => {
    const browser = crearBrowserMock();
    const mgr = new SessionManager(configClave, browser);
    expect(mgr.obtenerBrowser()).toBe(browser);
  });
});
