import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/bienesRaices';
import {
  schemaListBienesRaices, schemaSoloRut, schemaRol, schemaCertificadoAvaluo, schemaDocumento,
} from '../../core/schemas/bienesRaices';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest } from './comun';

// Bienes raíces. Todas aceptan clave tributaria O certificado (`conCredencial`),
// igual que el resto de las consultas: la ruta original sólo aceptaba clave por
// herencia del scraper de navegador, y la API del portal responde igual con las
// dos —verificado con certificado real.
const zodList = conCredencial(schemaListBienesRaices);
const zodSoloRut = conCredencial(schemaSoloRut);
const zodRol = conCredencial(schemaRol);
const zodCertificado = conCredencial(schemaCertificadoAvaluo);
const zodDocumento = conCredencial(schemaDocumento);

// Un PDF se envuelve a mano: `ejecutar` spreadea el resultado, y spreadear un
// Buffer produce {"0":37,"1":80,...}. Mismo contrato que los PDF de BHE y mipyme.
function respuestaPdf(contenido: Buffer, nombreArchivo: string, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    content_type: 'application/pdf',
    nombre_archivo: nombreArchivo,
    tamano_bytes: contenido.length,
    pdf_base64: contenido.toString('base64'),
  };
}

export function registrarRutasBienesRaices(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  // La ruta histórica conserva su nombre y su forma de respuesta; sólo suma
  // campos (los códigos del catastro) y acepta certificado.
  rutas.set('POST /v1/persona/bienes-raices', async body => {
    const parseo = zodList.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.listBienesRaices(ejecutor, rut));
  });

  rutas.set('POST /v1/bienes-raices/comunas', async body => {
    const parseo = zodSoloRut.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.comunas(ejecutor, rut));
  });

  rutas.set('POST /v1/bienes-raices/solicitudes', async body => {
    const parseo = zodSoloRut.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.solicitudes(ejecutor, rut));
  });

  rutas.set('POST /v1/bienes-raices/multipropietarios', async body => {
    const parseo = zodRol.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, comuna, manzana, predio } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.multipropietarios(ejecutor, rut, { comuna, manzana, predio }));
  });

  // Consulta de un predio CUALQUIERA por rol, la misma que el portal ofrece a
  // terceros: no exige ser el propietario.
  rutas.set('POST /v1/bienes-raices/consultar-rol', async body => {
    const parseo = zodRol.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, comuna, manzana, predio } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.consultarPorRol(ejecutor, rut, { comuna, manzana, predio }));
  });

  // Genera un certificado de avalúo. Es una SOLICITUD real que queda en el
  // historial del contribuyente, no una lectura: no se cachea ni se reintenta.
  rutas.set('POST /v1/bienes-raices/certificado-avaluo', async body => {
    const parseo = zodCertificado.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, bienes, tipo } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(async () => {
      const pdf = await core.certificadoAvaluo(ejecutor, rut,
        bienes.map(b => ({ comuna: b.comuna, manzana: b.manzana, predio: b.predio, ultimoEacAplicado: b.ultimo_eac_aplicado })),
        tipo);
      return respuestaPdf(pdf, `certificado-avaluo-${tipo}.pdf`, { tipo });
    });
  });

  // Baja el PDF de una solicitud ya generada (por ejemplo un certificado de
  // antecedentes pedido desde el portal), por la `url` que publica /solicitudes.
  rutas.set('POST /v1/bienes-raices/documento', async body => {
    const parseo = zodDocumento.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, url } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(async () => {
      const pdf = await core.descargarDocumento(ejecutor, rut, url);
      // El folio es el último segmento de la url; el schema ya lo dejó en
      // [A-Za-z0-9], así que no puede traer separadores de ruta.
      const folio = url.split('/').pop() ?? 'documento';
      return respuestaPdf(pdf, `bienes-raices-${folio}.pdf`, { url });
    });
  });
}
