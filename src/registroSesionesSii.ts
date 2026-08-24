import { Browser } from './browser';
import { ProveedorCredenciales } from './credenciales';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';

// Arma el registro multi-tenant de sesiones del SII: una `SessionManager` por
// RUT, construida con la credencial que entrega el proveedor. Es el punto donde
// se juntan las tres piezas —cola por RUT, registro genérico y proveedor de
// credenciales— con la sesión concreta.
//
// Cada RUT recibe su PROPIO `Browser`, o sea su propio contexto de
// agent-browser (`--session <rut>`). Antes se compartía uno solo, con el
// argumento de que el browser es "el proceso daemon, no estado por credencial".
// Eso es falso: el contexto guarda las COOKIES, que son la sesión del SII de un
// RUT concreto. Compartirlo tenía dos consecuencias graves, las dos verificables
// en el código:
//
//  - el login de un RUT podía ver las cookies de sesión de OTRO y darse por
//    exitoso con una credencial inválida;
//  - la limpieza previa al login de un RUT borraba la sesión viva de otro, que
//    seguía creyéndose autenticado por `autenticadoHasta` (2h) y se quedaba con
//    un cookie jar vacío, sin ningún error.
//
// La factory se puede inyectar para los tests; en producción es `new Browser(rut)`.
export function crearRegistroSesionesSii(
  proveedor: ProveedorCredenciales,
  browserPara: (rut: string) => Browser = rut => new Browser(rut)
): RegistroSesiones<SessionManager> {
  return new RegistroSesiones(async (rut: string) => {
    const config = await proveedor.para(rut);
    return new SessionManager(config, browserPara(rut));
  });
}
