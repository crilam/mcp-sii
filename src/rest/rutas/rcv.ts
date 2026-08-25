import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/rcv';
import { schemaResumen, schemaDetalle } from '../../core/schemas/rcv';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Clave tributaria O certificado, igual que BHE. Estas consultas no necesitaban
// certificado: la exigencia era herencia de cuando sólo el certificado sabía
// autenticar. Verificado contra el SII con clave real — RCV lee tanto el RUT
// propio como una empresa de la que la persona es representante, y la empresa
// acá es un parámetro del método, no un estado de la sesión que haya que
// seleccionar en alguna pantalla.
const zodResumen = conCredencial(schemaResumen);
const zodDetalle = conCredencial(schemaDetalle);

export function registrarRutasRcv(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/rcv/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, periodo, operacion, empresa_rut } = parseo.data;

    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.resumen(ejecutor, rut, periodo, operacion, empresa_rut));
  });

  rutas.set('POST /v1/rcv/detalle', async body => {
    const parseo = zodDetalle.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;

    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.detalle(ejecutor, rut, periodo, operacion, tipo_doc, empresa_rut));
  });
}
