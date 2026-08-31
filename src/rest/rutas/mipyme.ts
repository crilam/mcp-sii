import { z } from 'zod';
import { createHash } from 'crypto';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/mipyme';
import { schemaListEmpresas, schemaListDteEmitidos, schemaListDteRecibidos, schemaDtePdf, schemaListBorradores, schemaEmitirDte, schemaGuardarBorrador, paramsDocumento } from '../../core/schemas/mipyme';
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
const zodDtePdf = conCredencial(schemaDtePdf);
const zodListBorradores = conCredencial(schemaListBorradores);
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

  rutas.set('POST /v1/mipyme/dte-pdf', async body => {
    const parseo = zodDtePdf.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, empresa_rut, codigo } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(async () => {
      const contenido = await core.dtePdf(ejecutor, rut, codigo, empresa_rut);
      // Se envuelve a mano: `ejecutar` spreadea el resultado, y spreadear un
      // Buffer produciría {"0":37,"1":80,...} — un JSON enorme e inservible.
      return {
        codigo,
        // Constante y no un eco del SII: el scraper ya rechazó todo lo que no
        // fuera application/pdf. Se manda para que el tenant no lo asuma.
        content_type: 'application/pdf',
        // El schema ya exige sólo dígitos; el saneo va igual porque este valor
        // viaja a un consumidor que puede usarlo como nombre de archivo real, y
        // un separador acá sería path traversal allá.
        nombre_archivo: `mipyme-dte-${codigo.replace(/[^A-Za-z0-9]/g, '')}.pdf`,
        tamano_bytes: contenido.length,
        pdf_base64: contenido.toString('base64'),
      };
    });
  });

  rutas.set('POST /v1/mipyme/list-borradores', async body => {
    const parseo = zodListBorradores.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, empresa_rut } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.listBorradores(ejecutor, rut, empresa_rut));
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
    return ejecutar(() => core.emitirDte(ejecutor, datos.rut, paramsDocumento(datos), false));
  });

  // Guardar borrador: reversible, NO firma → acepta clave o certificado, y sí
  // soporta confirmar:true (a diferencia de emitir-dte). El guardrail: sin
  // confirmar, simula; con confirmar, graba.
  const zodBorrador = conCredencial(schemaGuardarBorrador);
  rutas.set('POST /v1/mipyme/borrador', async body => {
    const parseo = zodBorrador.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const datos = parseo.data;
    const doc = paramsDocumento(datos); // una sola vez: el hash de la traza cuadra con lo mandado
    const ejecutor = ejecutorPara(registro, credenciales, datos.rut, credencialDe(datos));
    const resp = await ejecutar(() => core.guardarBorrador(ejecutor, datos.rut, doc, datos.confirmar, datos.borrador_id));
    // Traza de auditoría de la escritura (misma mecánica que el acuse del RCV).
    const respBody = resp.body as { ok?: boolean; error?: string; borradorId?: string | null };
    // Referencia del acto: el id del borrador cuando el SII lo da (edición), o
    // tipo+receptor + un hash corto del documento cuando no (borrador nuevo), para
    // que dos borradores distintos al mismo receptor no colisionen en la traza.
    const hashDoc = createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 8);
    const referencia = `borrador:${respBody?.borradorId ?? `${datos.tipo_dte}-${datos.receptor_rut}-${hashDoc}`}`;
    if (respBody?.ok && datos.confirmar) {
      resp.auditoria = { efecto: 'ejecutado', referencia };
    } else if (respBody?.ok) {
      resp.auditoria = { efecto: 'simulado', referencia };
    } else if (datos.confirmar && respBody?.error !== 'LIMITE_CONOCIDO') {
      // 'fallido' = un intento de escritura que el SII rechazó. Un LIMITE_CONOCIDO
      // acá es el bloqueo anti-doble-click: NO se tocó el SII, no es un intento
      // fallido, así que no ensucia la traza.
      resp.auditoria = { efecto: 'fallido', referencia };
    }
    // Una SIMULACIÓN que falla (!ok && !confirmar) NO deja traza: no se intentó
    // escribir nada, así que no hay acto que auditar. Mismo criterio que el acuse.
    return resp;
  });
}
