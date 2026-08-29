import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/misii';
import { schemaFichaContribuyente } from '../../core/schemas/misii';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

const zodFicha = conCredencial(schemaFichaContribuyente);

export function registrarRutasMisii(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  // Una sola ruta y no varias granulares: el portal entrega los tres payloads
  // en la MISMA página, así que partirla en `/datos`, `/actividades` y
  // `/regimen` gastaría tres sesiones del SII para leer tres veces lo mismo.
  rutas.set('POST /v1/misii/ficha-contribuyente', async body => {
    const parseo = zodFicha.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut } = parseo.data;

    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.fichaContribuyente(ejecutor, rut));
  });
}
