import { z } from 'zod';
import { OperacionDte } from '../../scrapers/dte';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/dte';
import { schemaListado, schemaDocumento } from '../../core/schemas/dte';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Clave tributaria O certificado, igual que BHE. La exigencia de certificado era
// herencia de cuando sólo él sabía autenticar, no un requisito del SII.
// Verificado contra el portal con clave real: los listados de recibidos
// devolvieron documentos tanto del RUT propio como de una empresa de la que la
// persona es representante.
const zodListado = conCredencial(schemaListado());
const zodDocumento = conCredencial(schemaDocumento);

export function registrarRutasDte(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  const rutaListado = (nombre: string, operacion: OperacionDte) => {
    rutas.set(`POST /v1/dte/${nombre}`, async body => {
      const parseo = zodListado.safeParse(body);
      if (!parseo.success) return badRequest(parseo.error);
      const { rut, periodo, empresa_rut, tipo_doc, seccion, contraparte_rut, limit, incluir_detalle } = parseo.data;
      const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
      return ejecutar(() => core.listar(ejecutor, rut, periodo, operacion, {
        empresaRut: empresa_rut, tipoDocCodigo: tipo_doc, seccion,
        contraparteRut: contraparte_rut, limit, incluirDetalle: incluir_detalle,
      }));
    });
  };

  const rutaDocumento = (nombre: string, operacion: OperacionDte) => {
    rutas.set(`POST /v1/dte/${nombre}`, async body => {
      const parseo = zodDocumento.safeParse(body);
      if (!parseo.success) return badRequest(parseo.error);
      const { rut, periodo, tipo_doc, folio, empresa_rut } = parseo.data;
      const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
      return ejecutar(() => core.getDocumento(ejecutor, rut, periodo, operacion, tipo_doc, folio, empresa_rut));
    });
  };

  rutaListado('list-documentos-emitidos', 'EMITIDOS');
  rutaListado('list-documentos-recibidos', 'RECIBIDOS');
  rutaDocumento('get-documento-emitido', 'EMITIDOS');
  rutaDocumento('get-documento-recibido', 'RECIBIDOS');
}
