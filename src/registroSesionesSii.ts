import { Browser } from './browser';
import { ProveedorCredenciales } from './credenciales';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';

// Arma el registro multi-tenant de sesiones del SII: una `SessionManager` por
// RUT, construida con la credencial que entrega el proveedor. Es el punto donde
// se juntan las tres piezas —cola por RUT, registro genérico y proveedor de
// credenciales— con la sesión concreta.
//
// El `Browser` se comparte entre todas las sesiones: es el proceso de
// agent-browser (un daemon), no estado por credencial. La sesión del SII —lo que
// no se puede compartir— vive en el cookie jar, que ya es por RUT.
export function crearRegistroSesionesSii(
  proveedor: ProveedorCredenciales,
  browser: Browser
): RegistroSesiones<SessionManager> {
  return new RegistroSesiones(async (rut: string) => {
    const config = await proveedor.para(rut);
    return new SessionManager(config, browser);
  });
}
