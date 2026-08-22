import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/bhe';
import { schemaResumen, schemaMes } from '../../core/schemas/bhe';
import { ejecutorPassThroughCertDe } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar } from './comun';

const zodResumen = z.object(schemaResumen).extend({
  certificado_base64: z.string().min(1),
  certificado_password: z.string().min(1),
});
const zodMes = z.object(schemaMes).extend({
  certificado_base64: z.string().min(1),
  certificado_password: z.string().min(1),
});

export function registrarRutasBhe(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/bhe/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, anio } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.resumen(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/bhe/list-emitidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, anio, mes } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.listEmitidas(ejecutor, rut, anio, mes));
  });

  rutas.set('POST /v1/bhe/list-recibidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, anio, mes } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.listRecibidas(ejecutor, rut, anio, mes));
  });
}
