import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/renta';
import { schemaEstadoDeclaracion, schemaF22 } from '../../core/schemas/renta';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Clave tributaria O certificado, igual que BHE. La renta cuelga de la persona,
// así que la clave alcanza; el certificado se exigía por herencia de cuando era
// la única estrategia que sabía autenticar. Verificado contra el SII con clave
// real (dos declaraciones leídas para 2025).
const zodEstadoDeclaracion = conCredencial(schemaEstadoDeclaracion);
const zodF22 = conCredencial(schemaF22);

export function registrarRutasRenta(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/renta/estado-declaracion', async body => {
    const parseo = zodEstadoDeclaracion.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, anio } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.estadoDeclaracion(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/renta/f22', async body => {
    const parseo = zodF22.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, anio, folio } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.f22Completo(ejecutor, rut, anio, folio));
  });
}
