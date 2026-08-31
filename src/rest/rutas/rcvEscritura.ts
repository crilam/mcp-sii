import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/rcvEscritura';
import { schemaEventosAcuse, schemaAcusar } from '../../core/schemas/rcvEscritura';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Primera ESCRITURA del servicio (ronda 11): acuse de recibo de documentos del
// RCV. Con `confirmar:false` (default) simula; con `true` cursa el acto real.
const zodEventos = conCredencial(schemaEventosAcuse);
const zodAcusar = conCredencial(schemaAcusar);

export function registrarRutasRcvEscritura(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/rcv/eventos-acuse', async body => {
    const p = zodEventos.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut } = p.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    return ejecutar(() => core.eventosAcuse(ejecutor, rut));
  });

  rutas.set('POST /v1/rcv/acuse', async body => {
    const p = zodAcusar.safeParse(body);
    if (!p.success) return badRequest(p.error);
    const { rut, documentos, evento, confirmar } = p.data;
    const docs = documentos.map(d => ({ rutEmisor: d.rut_emisor, tipoDoc: d.tipo_doc, folio: d.folio }));
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(p.data));
    const resp = await ejecutar(() => core.acusar(ejecutor, rut, docs, evento, confirmar));
    // Traza de auditoría de la escritura: simulado vs ejecutado, y qué documentos.
    if ((resp.body as { ok?: boolean })?.ok) {
      resp.auditoria = {
        efecto: confirmar ? 'ejecutado' : 'simulado',
        referencia: `${evento}:${docs.map(d => `${d.rutEmisor}/${d.tipoDoc}-${d.folio}`).join(',')}`,
      };
    }
    return resp;
  });
}
