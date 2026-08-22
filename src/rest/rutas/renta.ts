import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/renta';
import { schemaEstadoDeclaracion, schemaF22 } from '../../core/schemas/renta';
import { ejecutorPassThroughCertDe } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar } from './comun';

const zodEstadoDeclaracion = z.object(schemaEstadoDeclaracion).extend({
  certificado_base64: z.string().min(1),
  certificado_password: z.string().min(1),
});
const zodF22 = z.object(schemaF22).extend({
  certificado_base64: z.string().min(1),
  certificado_password: z.string().min(1),
});

export function registrarRutasRenta(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/renta/estado-declaracion', async body => {
    const parseo = zodEstadoDeclaracion.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, anio } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.estadoDeclaracion(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/renta/f22', async body => {
    const parseo = zodF22.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, anio, folio } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.f22Completo(ejecutor, rut, anio, folio));
  });
}
