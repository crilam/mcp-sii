import { randomUUID } from 'crypto';
import { Browser } from './browser';
import { ProveedorCredenciales } from './credenciales';
import { RegistroSesiones } from './registroSesiones';
import { SessionManager } from './session';
import { cerrarSesionSii } from './cerrarSesionSii';

// Arma el registro multi-tenant de sesiones del SII: una `SessionManager` por
// RUT, construida con la credencial que entrega el proveedor. Es el punto donde
// se juntan las tres piezas —cola por RUT, registro genérico y proveedor de
// credenciales— con la sesión concreta.
//
// Cada sesión recibe su PROPIO `Browser`, o sea su propio contexto de
// agent-browser. Dos decisiones acá, y las dos importan:
//
// 1. No se comparte un contexto entre RUTs. Antes se compartía uno solo, con el
//    argumento de que el browser es "el proceso daemon, no estado por
//    credencial". Es falso: el contexto guarda las COOKIES, que son la sesión
//    del SII de un RUT concreto. Compartirlo permitía que el login de un RUT
//    viera las cookies de otro y se diera por exitoso con una credencial
//    inválida, y que la limpieza previa de uno borrara la sesión viva de otro
//    —que seguía creyéndose autenticado 2h y se quedaba con el jar vacío, sin
//    ningún error.
//
// 2. El id del contexto no es sólo el RUT, sino RUT + un correlativo. Con
//    `--session <rut>` a secas, TODAS las sesiones de un mismo RUT vuelven a
//    compartir contexto — incluida la que `ejecutarPassThrough` crea nueva por
//    request, que promete explícitamente "no heredar el cookie jar/estado de una
//    sesión anterior de ese RUT". Con el RUT como id esa promesa era falsa, y el
//    problema del punto 1 volvía a aparecer dentro del mismo RUT: un
//    `validar-clave` le borraba la sesión viva a la instancia cacheada.
//
// Al desalojar, el registro hace el cierre COMPLETO (`cerrarSesionSii`): logout
// del lado del SII y después el contexto local. Antes cerraba sólo el contexto,
// y eso era la mitad de la limpieza: liberaba el proceso y el perfil de disco,
// pero dejaba la sesión VIVA en el portal hasta que expirara. Como el SII limita
// las sesiones simultáneas por RUT (error 01.01.190.500.720.27), un consumidor
// que recorre un año —doce consultas del mismo RUT— iba acumulando sesiones
// abiertas hasta toparse con el bloqueo, y el fallo aparecía como un error
// intermitente sin relación aparente con lo que se estaba pidiendo.
//
// El id único lo arma ESTA función y la factory sólo lo recibe, en vez de
// dejar que la factory lo derive del RUT: así la unicidad no depende de quién
// inyecte la factory. Con la versión anterior, un consumidor (o un test) que
// pasara la suya volvía a tener un contexto por RUT sin notarlo, y con él los
// dos problemas de arriba.
export function crearRegistroSesionesSii(
  proveedor: ProveedorCredenciales,
  browserPara: (idContexto: string) => Browser = id => new Browser(id)
): RegistroSesiones<SessionManager> {
  return new RegistroSesiones(
    async (rut: string) => {
      const config = await proveedor.para(rut);
      // El RUT queda en el id para que el contexto sea rastreable en un `ps` o
      // en el directorio de perfiles; el UUID es lo que lo hace único.
      //
      // UUID y no un contador en memoria: el contador arranca en 0 en cada
      // reinicio del proceso, y `--session <id>` es un perfil PERSISTENTE en
      // disco — así que tras reiniciar, el id `<rut>-1` volvería a tomar el
      // perfil que dejó la corrida anterior, con sus cookies. Sería la misma
      // herencia de jar que esto viene a eliminar, colándose por el reinicio.
      return new SessionManager(config, browserPara(`${rut}-${randomUUID()}`));
    },
    sesion => cerrarSesionSii(sesion)
  );
}
