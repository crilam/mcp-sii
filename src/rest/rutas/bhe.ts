import { z } from 'zod';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/bhe';
import { schemaResumen, schemaMes, schemaPdf } from '../../core/schemas/bhe';
import { ejecutorPassThroughCertDe } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, zodCredencialCert } from './comun';

const zodResumen = z.object(schemaResumen).extend(zodCredencialCert);
const zodMes = z.object(schemaMes).extend(zodCredencialCert);
const zodPdf = z.object(schemaPdf).extend(zodCredencialCert);

export function registrarRutasBhe(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/bhe/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, anio } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.resumen(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/bhe/list-emitidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, anio, mes } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.listEmitidas(ejecutor, rut, anio, mes));
  });

  rutas.set('POST /v1/bhe/list-recibidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, anio, mes } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(() => core.listRecibidas(ejecutor, rut, anio, mes));
  });

  // El PDF viaja en base64 dentro del JSON, no como cuerpo binario: todo el
  // contrato REST es {ok:true,...} / {ok:false,error} con status 200, y una
  // ruta que devolviera application/pdf no tendría forma de expresar
  // {ok:false} sin romperlo para los tenants que ya lo consumen.
  //
  // Techo de tamaño para los tenants: el transporte corta la descarga en 4 MiB
  // (MAX_RESPUESTA_BYTES en http.ts), y base64 la infla ~33%, así que la
  // respuesta de esta ruta puede llegar a ~5,5 MB — más que las demás. En la
  // práctica una boleta pesa ~8 KB; el techo importa sólo como límite duro.
  rutas.set('POST /v1/bhe/pdf', async body => {
    const parseo = zodPdf.safeParse(body);
    if (!parseo.success) return { status: 400, body: { error: 'BAD_REQUEST' } };
    const { rut, certificado_base64, certificado_password, codigo_barras, recibida } = parseo.data;
    const ejecutor = ejecutorPassThroughCertDe(registro, credenciales, rut, certificado_base64, certificado_password);
    return ejecutar(async () => {
      const contenido = await core.pdf(ejecutor, rut, codigo_barras, recibida);
      // Se envuelve a mano: `ejecutar` spreadea el resultado, y spreadear un
      // Buffer produciría {"0":37,"1":80,...} — un JSON enorme e inservible.
      return {
        codigo_barras,
        // Constante, no un eco del SII: el scraper ya rechazó todo lo que no
        // fuera application/pdf, así que si llegamos acá el tipo es ese. Se
        // manda igual para que el tenant no tenga que asumirlo.
        content_type: 'application/pdf',
        // Nombre sugerido para que los tres tenants no lo inventen distinto.
        // Se sanea igual que si el schema no validara: este valor viaja a un
        // consumidor que probablemente lo use como nombre de archivo real, y un
        // separador acá sería path traversal allá. Defensa en profundidad: si
        // alguien relaja la regex del schema, esto sigue en pie.
        nombre_archivo: `bhe-${codigo_barras.replace(/[^A-Za-z0-9]/g, '')}.pdf`,
        tamano_bytes: contenido.length,
        pdf_base64: contenido.toString('base64'),
      };
    });
  });
}
