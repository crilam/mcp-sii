import { z } from 'zod';
import { OperacionDte } from '../../scrapers/dte';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/dte';
import { schemaListado, schemaDocumento } from '../../core/schemas/dte';
import { clasificarErrorCredenciales } from '../../erroresSesion';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler } from './rcv';

const zodListado = z.object(schemaListado()).extend({ clave: z.string().min(1) });
const zodDocumento = z.object(schemaDocumento).extend({ clave: z.string().min(1) });

async function ejecutar<R>(fn: () => Promise<R>) {
  try {
    const resultado = await fn();
    return { status: 200, body: { ok: true, ...(resultado as object) } };
  } catch (e) {
    return { status: 200, body: { ok: false, error: clasificarErrorCredenciales(e) } };
  }
}

export function registrarRutasDte(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  const rutaListado = (nombre: string, operacion: OperacionDte) => {
    rutas.set(`POST /v1/dte/${nombre}`, async body => {
      const parseo = zodListado.safeParse(body);
      if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
      const { rut, clave, periodo, empresa_rut, tipo_doc, seccion, contraparte_rut, limit, incluir_detalle } = parseo.data;
      const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
      return ejecutar(() => core.listar(ejecutor, rut, periodo, operacion, {
        empresaRut: empresa_rut, tipoDocCodigo: tipo_doc, seccion,
        contraparteRut: contraparte_rut, limit, incluirDetalle: incluir_detalle,
      }));
    });
  };

  const rutaDocumento = (nombre: string, operacion: OperacionDte) => {
    rutas.set(`POST /v1/dte/${nombre}`, async body => {
      const parseo = zodDocumento.safeParse(body);
      if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
      const { rut, clave, periodo, tipo_doc, folio, empresa_rut } = parseo.data;
      const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
      return ejecutar(() => core.getDocumento(ejecutor, rut, periodo, operacion, tipo_doc, folio, empresa_rut));
    });
  };

  rutaListado('list-documentos-emitidos', 'EMITIDOS');
  rutaListado('list-documentos-recibidos', 'RECIBIDOS');
  rutaDocumento('get-documento-emitido', 'EMITIDOS');
  rutaDocumento('get-documento-recibido', 'RECIBIDOS');
}
