import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/dteVerificacion';
import { schemaValidezDte, schemaContenidoDte } from '../../core/schemas/dteVerificacion';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Verificación de DTE. Eran consultas públicas y el SII las puso detrás del
// login, así que van con la credencial estándar como el resto.
const zodValidez = conCredencial(schemaValidezDte);
const zodContenido = conCredencial(schemaContenidoDte);

export function registrarRutasDteVerificacion(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/dte/validez', async body => {
    const p = zodValidez.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut, rut_emisor, tipo_dte, folio } = p.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    return ejecutar(() => core.validez(ejecutor, rut, { rutEmisor: rut_emisor, tipoDte: tipo_dte, folio }));
  });

  rutas.set('POST /v1/dte/verificar', async body => {
    const p = zodContenido.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut, rut_emisor, tipo_dte, folio, rut_receptor, fecha_emision, monto_total } = p.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    return ejecutar(() => core.contenido(ejecutor, rut, {
      rutEmisor: rut_emisor, tipoDte: tipo_dte, folio,
      rutReceptor: rut_receptor, fechaEmision: fecha_emision, montoTotal: monto_total,
    }));
  });
}
