import { Browser } from '../../src/browser';
import { SessionManager } from '../../src/session';
import { AuthStrategy } from '../../src/env';
import { clasificarErrorCredenciales } from '../../src/erroresSesion';

// Pruebas contra el SII REAL. No corren con `npm test`: hay que pedirlas
// explícitamente con `npm run test:e2e`, porque cada una abre una sesión de
// verdad en el portal y el SII limita las sesiones simultáneas por RUT y bloquea
// las claves con varios intentos fallidos.
//
// Existen porque el bug que más caro salió de este módulo —`validar-clave`
// respondiendo ok:true con CUALQUIER clave— no lo podía detectar ningún test
// con el navegador mockeado: el criterio de éxito estaba mal, y el mock decía
// que sí porque le habíamos enseñado a decir que sí. La única prueba que sirve
// para eso es la que le pregunta al portal.
//
// Se saltean solas (no fallan) si no hay credenciales en el entorno, para que
// alguien sin `.env` pueda correr la suite sin ruido.

const RUT = process.env.SII_RUT;
const CLAVE = process.env.SII_CLAVE;
const hayCredenciales = Boolean(RUT && CLAVE);

// El SII bloquea una clave tras varios intentos fallidos, así que el caso que
// manda una clave incorrecta al RUT propio queda detrás de su propio flag:
// `SII_E2E_CLAVE_MALA=1 npm run test:e2e`. Es el único que ejercita la
// clasificación CREDENCIALES_INVALIDAS de punta a punta.
const probarClaveMala = process.env.SII_E2E_CLAVE_MALA === '1';

// RUT válido en formato (DV correcto) que no le pertenece a nadie de este
// proyecto. Sirve para probar que un login que NO debe pasar no pasa, sin
// acumular intentos fallidos sobre una cuenta propia ni la de un tercero.
//
// Ojo con lo que este caso NO prueba: el portal no responde "clave incorrecta"
// para este RUT, sino "El RUT ingresado corresponde al de una persona fallecida
// hace más de 3 años" (código 01.01.225.500.602.58, verificado en vivo). O sea
// que cubre el anti-falso-positivo —lo que causó el incidente— pero no la
// clasificación de credencial inválida. Para eso está el caso de arriba.
const RUT_SIN_CUENTA = '11111111-1';

// Cada test usa su propio contexto de navegador y lo cierra al terminar: dejarlo
// abierto consume una sesión del SII, que es el recurso escaso acá.
async function conSesion<T>(
  config: { rut: string; clave: string },
  fn: (s: SessionManager, b: Browser) => Promise<T>
): Promise<T> {
  const browser = new Browser(`e2e-${config.rut}-${Date.now()}`);
  const sesion = new SessionManager(
    { rut: config.rut, clave: config.clave, strategy: AuthStrategy.Clave },
    browser
  );
  try {
    return await fn(sesion, browser);
  } finally {
    try { browser.close(); } catch { /* el navegador ya no está; no importa */ }
  }
}

// Los logins reales tardan segundos (el rechazo agota el poll de 15s en el peor
// caso), muy por encima del default de 5s de jest.
const TIMEOUT_MS = 90_000;

const describeConCredenciales = hayCredenciales ? describe : describe.skip;

describeConCredenciales('login por clave contra el SII real', () => {
  it('la clave correcta autentica y deja una sesión usable', async () => {
    await conSesion({ rut: RUT!, clave: CLAVE! }, async (sesion, browser) => {
      await sesion.authenticateOnly();

      // No alcanza con que no haya lanzado: eso es exactamente lo que hacía el
      // código con el bug. Se comprueba la evidencia de que hay sesión — las
      // cookies que el SII sólo emite cuando autenticó, con valor.
      //
      // (No se usa `rutaCookieJar()`: ese camino todavía exige certificado
      // digital, aunque las cookies del login por clave sirvan igual para las
      // consultas HTTP. Es un pendiente conocido, ajeno a lo que se prueba acá.)
      const cookies = browser.cookiesDelSiiConUbicacion();
      const conValor = cookies.filter(c => c.tieneValor).map(c => c.name);
      expect(conValor).toContain('TOKEN');
      expect(conValor).toContain('CSESSIONID');

      const { rut } = sesion.identidad();
      expect(rut).toBeTruthy();
    });
  }, TIMEOUT_MS);

  // EL test de esta suite: es el caso que estuvo roto en producción. Un RUT que
  // no puede autenticar no debe reportarse como autenticado, pase lo que pase.
  it('un login que no puede tener éxito NO se reporta como exitoso', async () => {
    await conSesion({ rut: RUT_SIN_CUENTA, clave: 'ClaveInventada-9999' }, async sesion => {
      await expect(sesion.authenticateOnly()).rejects.toThrow();
    });
  }, TIMEOUT_MS);

  (probarClaveMala ? it : it.skip)(
    'la clave incorrecta se clasifica como CREDENCIALES_INVALIDAS',
    async () => {
      await conSesion({ rut: RUT!, clave: `${CLAVE}-definitivamente-no` }, async sesion => {
        const error = await sesion.authenticateOnly().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        // Lo que importa no es el texto sino cómo lo clasifica el contrato: es
        // el veredicto que Tributy usa para decidir si guarda la credencial.
        expect(clasificarErrorCredenciales(error)).toBe('CREDENCIALES_INVALIDAS');
      });
    },
    TIMEOUT_MS
  );
});
