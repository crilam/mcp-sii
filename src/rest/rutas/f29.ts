import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/f29';
import { schemaEstadoF29, schemaCompactoF29 } from '../../core/schemas/f29';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Formulario 29 (IVA mensual). Consulta del portal, detrás del login, con la
// credencial estándar.
const zodEstado = conCredencial(schemaEstadoF29);
const zodCompacto = conCredencial(schemaCompactoF29);

export function registrarRutasF29(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/f29/estado-declaracion', async body => {
    const p = zodEstado.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut, periodo } = p.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    return ejecutar(() => core.estadoDeclaracion(ejecutor, rut, periodo));
  });

  rutas.set('POST /v1/f29/formulario-compacto', async body => {
    const p = zodCompacto.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut, periodo } = p.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    return ejecutar(async () => {
      const c = await core.compacto(ejecutor, rut, periodo);
      // El PDF se envuelve a mano: `ejecutar` spreadea el resultado y un Buffer
      // spreadeado da {"0":37,...}. Mismo contrato que los demás PDF.
      return {
        periodo: c.periodo, folio: c.folio, estado: c.estado, observaciones: c.observaciones,
        fecha_presentacion: c.fechaPresentacion, moneda: c.moneda,
        content_type: 'application/pdf',
        nombre_archivo: `f29-compacto-${c.periodo}.pdf`,
        tamano_bytes: c.pdf.length,
        pdf_base64: c.pdf.toString('base64'),
      };
    });
  });
}
