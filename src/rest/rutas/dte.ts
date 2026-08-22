import { z } from 'zod';
import { OperacionDte } from '../../scrapers/dte';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/dte';
import { schemaListado, schemaDocumento } from '../../core/schemas/dte';
import { ejecutorPassThroughCertDe } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, zodCredencialCert } from './comun';

const zodListado = z.object(schemaListado()).extend(zodCredencialCert);
const zodDocumento = z.object(schemaDocumento).extend(zodCredencialCert);

export function registrarRutasDte(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  const rutaListado = (nombre: string, operacion: OperacionDte) => {
    rutas.set(`POST /v1/dte/${nombre}`, async body => {
      const parseo = zodListado.safeParse(body);
      if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
      const { rut, certificado_base64, certificado_password, periodo, empresa_rut, tipo_doc, seccion, contraparte_rut, limit, incluir_detalle } = parseo.data;
      const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
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
      const { rut, certificado_base64, certificado_password, periodo, tipo_doc, folio, empresa_rut } = parseo.data;
      const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
      return ejecutar(() => core.getDocumento(ejecutor, rut, periodo, operacion, tipo_doc, folio, empresa_rut));
    });
  };

  rutaListado('list-documentos-emitidos', 'EMITIDOS');
  rutaListado('list-documentos-recibidos', 'RECIBIDOS');
  rutaDocumento('get-documento-emitido', 'EMITIDOS');
  rutaDocumento('get-documento-recibido', 'RECIBIDOS');
}
