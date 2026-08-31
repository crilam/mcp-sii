import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/rcv';
import * as coreAsync from '../../core/rcvAsync';
import { schemaResumen, schemaDetalle, schemaEmpresasAutorizadas, schemaTiposDocumento, schemaAsyncSolicitar, schemaAsyncEstado, schemaAsyncDetalle } from '../../core/schemas/rcv';
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
const zodEmpresasAutorizadas = conCredencial(schemaEmpresasAutorizadas);
const zodTiposDocumento = conCredencial(schemaTiposDocumento);
const zodAsyncSolicitar = conCredencial(schemaAsyncSolicitar);
const zodAsyncEstado = conCredencial(schemaAsyncEstado);
const zodAsyncDetalle = conCredencial(schemaAsyncDetalle);

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

  // Empresas que el RUT puede consultar en el RCV. Es un universo distinto del
  // de `/v1/mipyme/list-empresas`, que son las que puede OPERAR en el portal de
  // facturación: un RUT puede estar en una lista y no en la otra.
  rutas.set('POST /v1/rcv/empresas-autorizadas', async body => {
    const parseo = zodEmpresasAutorizadas.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.empresasAutorizadas(ejecutor, rut));
  });

  // Catálogo de tipos de documento. Existe porque `detalle` EXIGE un tipo y no
  // hay "detalle del período entero": sin esto hay que adivinar los códigos, o
  // sacarlos de un resumen que sólo lista los que tuvieron movimiento.
  rutas.set('POST /v1/rcv/tipos-documento', async body => {
    const parseo = zodTiposDocumento.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.tiposDocumento(ejecutor, rut));
  });

  rutas.set('POST /v1/rcv/detalle', async body => {
    const parseo = zodDetalle.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;

    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.detalle(ejecutor, rut, periodo, operacion, tipo_doc, empresa_rut));
  });

  // --- Descarga asíncrona (cierre R1) --------------------------------------
  // Para volúmenes que el detalle síncrono no alcanza. Tres pasos que el
  // consumidor orquesta: solicitar → estado (polling) → detalle. El servicio no
  // guarda estado: cada llamada consulta al SII con la misma llave natural
  // (período + operación + tipo_doc).
  rutas.set('POST /v1/rcv/async/solicitar', async body => {
    const parseo = zodAsyncSolicitar.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => coreAsync.solicitar(ejecutor, rut, periodo, operacion, tipo_doc, empresa_rut));
  });

  rutas.set('POST /v1/rcv/async/estado', async body => {
    const parseo = zodAsyncEstado.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => coreAsync.estado(ejecutor, rut, periodo, operacion, tipo_doc, empresa_rut));
  });

  rutas.set('POST /v1/rcv/async/detalle', async body => {
    const parseo = zodAsyncDetalle.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, periodo, operacion, tipo_doc, empresa_rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => coreAsync.detalle(ejecutor, rut, periodo, operacion, tipo_doc, empresa_rut));
  });
}
