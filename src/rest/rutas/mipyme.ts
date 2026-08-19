import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/mipyme';
import { schemaListEmpresas, schemaListDteEmitidos, schemaEmitirDte } from '../../core/schemas/mipyme';
import { ejecutorPassThroughDe } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar } from './comun';

const zodListEmpresas = z.object(schemaListEmpresas).extend({ clave: z.string().min(1) });
const zodListDteEmitidos = z.object(schemaListDteEmitidos).extend({ clave: z.string().min(1) });
const zodEmitirDte = z.object(schemaEmitirDte).extend({ clave: z.string().min(1) });

export function registrarRutasMipyme(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/mipyme/list-empresas', async body => {
    const parseo = zodListEmpresas.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listEmpresas(ejecutor, rut));
  });

  rutas.set('POST /v1/mipyme/list-dte-emitidos', async body => {
    const parseo = zodListDteEmitidos.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, clave, empresa_rut, tipo_dte, fecha_desde, fecha_hasta, receptor_rut, folio, pagina } = parseo.data;
    const ejecutor = ejecutorPassThroughDe(registro, credenciales, rut, clave);
    return ejecutar(() => core.listDteEmitidos(ejecutor, rut, {
      empresaRut: empresa_rut, tipoDte: tipo_dte, fechaDesde: fecha_desde,
      fechaHasta: fecha_hasta, receptorRut: receptor_rut, folio, pagina,
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
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const datos = parseo.data;
    if (datos.confirmar) {
      return { status: 400, body: { error: 'CONFIRMAR_NO_SOPORTADO' } };
    }

    const ejecutor = ejecutorPassThroughDe(registro, credenciales, datos.rut, datos.clave);
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
