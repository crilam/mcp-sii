import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/mipyme';
import { schemaListEmpresas, schemaListDteEmitidos, schemaListDteRecibidos, schemaEmitirDte } from '../../core/schemas/mipyme';
import { ejecutorPara, ejecutorPassThroughCertDe } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest, zodCredencialCert } from './comun';

// Las dos LECTURAS aceptan clave tributaria O certificado, igual que BHE:
// verificado contra el SII con clave real (list-empresas devolvió las cinco
// empresas de la persona). `emitir-dte` NO cambia y sigue exigiendo certificado
// —ver el comentario de su ruta más abajo—: firmar un DTE necesita el
// certificado de verdad, no sólo una sesión autenticada.
const zodListEmpresas = conCredencial(schemaListEmpresas);
const zodListDteEmitidos = conCredencial(schemaListDteEmitidos);
const zodListDteRecibidos = conCredencial(schemaListDteRecibidos);
const zodEmitirDte = z.object(schemaEmitirDte).extend({
  ...zodCredencialCert,
  // `clave` se RECHAZA explícitamente, no se ignora. Sin esto, un body que
  // trajera clave y certificado pasaba la validación, zod descartaba la clave en
  // silencio y se firmaba con el certificado: el caller creía haber usado una
  // credencial y se usó la otra, en la única ruta que firma. Todas las demás
  // rutas rechazan esa mezcla vía `conCredencial`, y acá tiene que valer lo
  // mismo aunque el régimen sea sólo-certificado.
  // `z.never()` y no `z.undefined()`: con undefined, un body que trajera
  // `"clave": null` pasaba igual —null no es undefined— y se firmaba con el
  // certificado, que es exactamente el caso que esto viene a cerrar. Con never,
  // la presencia de la clave con CUALQUIER valor se rechaza.
  clave: z.never({
    error:
      'emitir-dte no acepta clave tributaria: firmar un DTE requiere certificado digital. ' +
      'Mandá certificado_base64 y certificado_password, sin clave.',
  }).optional(),
  confirmar: z.boolean().default(false)
    .describe('false (default) = sólo previsualiza. true = FIRMA Y EMITE el documento — NO SOPORTADO vía REST todavía, ver limitación conocida de la spec.'),
});

export function registrarRutasMipyme(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/mipyme/list-empresas', async body => {
    const parseo = zodListEmpresas.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.listEmpresas(ejecutor, rut));
  });

  rutas.set('POST /v1/mipyme/list-dte-emitidos', async body => {
    const parseo = zodListDteEmitidos.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, folio, pagina } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.listDteEmitidos(ejecutor, rut, {
      empresaRut: empresa_rut, tipoDte: tipo_dte, fechaDesde: fecha_desde,
      fechaHasta: fecha_hasta, receptorRut: receptor_rut, folio, pagina,
    }));
  });

  rutas.set('POST /v1/mipyme/list-dte-recibidos', async body => {
    const parseo = zodListDteRecibidos.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, empresa_rut, tipo_dte, fecha_desde, fecha_hasta, emisor_rut, folio, pagina } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.listDteRecibidos(ejecutor, rut, {
      empresaRut: empresa_rut, tipoDte: tipo_dte, fechaDesde: fecha_desde,
      fechaHasta: fecha_hasta, emisorRut: emisor_rut, folio, pagina,
    }));
  });

  // sii_mipyme_emitir_dte con confirmar=true firma con certificado digital,
  // cuya clave hoy sólo se configura vía env vars del PROCESO
  // (SII_CERT_CLAVE_SII/SII_CERT_PASSWORD) — incompatible con credencial por
  // request. Rechazo explícito, no silencioso: un caller que mande
  // confirmar=true merece saber que no se soporta, no una previsualización
  // sorpresa. Ver limitación conocida de la spec y el pendiente de
  // certificado digital en la memoria del proyecto.
  rutas.set('POST /v1/mipyme/emitir-dte', async body => {
    const parseo = zodEmitirDte.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const datos = parseo.data;
    if (datos.confirmar) {
      return { status: 400, body: { error: 'CONFIRMAR_NO_SOPORTADO' } };
    }

    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, datos.rut, datos.certificado_base64, datos.certificado_password);
    return ejecutar(() => core.emitirDte(ejecutor, datos.rut, {
      empresaRut: datos.empresa_rut,
      tipoDte: datos.tipo_dte,
      receptor: {
        rut: datos.receptor_rut, dv: datos.receptor_dv, razonSocial: datos.receptor_razon_social,
        giro: datos.receptor_giro, direccion: datos.receptor_direccion, comuna: datos.receptor_comuna,
        ciudad: datos.receptor_ciudad,
      },
      lineas: datos.lineas.map(l => ({
        nombre: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precio_unitario, unidad: l.unidad,
      })),
      formaPago: datos.forma_pago,
      ciudadEmisor: datos.ciudad_emisor,
      fechaEmision: datos.fecha_emision,
      referencias: datos.referencias?.map(r => ({
        tipoDoc: r.tipo_doc, folio: r.folio, fecha: r.fecha, razon: r.razon, codigo: r.codigo,
      })),
    }, false));
  });
}
