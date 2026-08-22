import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/rcv';
import { schemaResumen, schemaDetalle } from '../../core/schemas/rcv';
import { ejecutorPassThroughCertDe } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, zodCredencialCert } from './comun';

const zodResumen = z.object(schemaResumen).extend(zodCredencialCert);
const zodDetalle = z.object(schemaDetalle).extend(zodCredencialCert);

export function registrarRutasRcv(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/rcv/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, periodo, operacion, empresa_rut } = parseo.data;

    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.resumen(ejecutor, rut, periodo, operacion, empresa_rut));
  });

  rutas.set('POST /v1/rcv/detalle', async body => {
    const parseo = zodDetalle.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;

    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.detalle(ejecutor, rut, periodo, operacion, tipo_doc, empresa_rut));
  });
}
