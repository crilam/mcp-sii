import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/misii';
import { schemaDatosContribuyente } from '../../core/schemas/misii';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Mi SII: los datos del contribuyente autenticado. Clave o certificado, como
// todas las consultas.
const zodDatos = conCredencial(schemaDatosContribuyente);

export function registrarRutasMisii(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/misii/datos-contribuyente', async body => {
    const parseo = zodDatos.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.datosContribuyente(ejecutor, rut));
  });
}
