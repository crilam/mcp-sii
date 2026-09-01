import { z } from 'zod';
import { createHash } from 'crypto';
import { claveEstable } from '../../idempotenciaEscritura';
import { RegistroSesiones } from '../../registroSesiones';
import { SessionManager } from '../../session';
import { ProveedorCredencialesRuntime } from '../../credencialesRuntime';
import * as core from '../../core/bhe';
import * as coreEmision from '../../core/bheEmision';
import * as coreAnulacion from '../../core/bheAnulacion';
import * as coreObservacion from '../../core/bheObservacion';
import * as coreEmail from '../../core/bheEmail';
import { schemaResumen, schemaMes, schemaPdf, schemaEmitirBhe, schemaAnularBhe, schemaObservarBhe, schemaEmailBhe } from '../../core/schemas/bhe';
import { ejecutorPara } from '../ejecutorPassThrough';
import { RutaHandler, ejecutar, conCredencial, credencialDe, badRequest, ERROR_LIMITE_CONOCIDO } from './comun';

// Las tres aceptan clave tributaria O certificado digital: las dos autentican y
// las dos producen el cookie jar que estas consultas necesitan.
const zodResumen = conCredencial(schemaResumen);
const zodMes = conCredencial(schemaMes);
const zodPdf = conCredencial(schemaPdf);
const zodEmitir = conCredencial(schemaEmitirBhe);
const zodAnular = conCredencial(schemaAnularBhe);
const zodObservar = conCredencial(schemaObservarBhe);
const zodEmail = conCredencial(schemaEmailBhe);

export function registrarRutasBhe(
  rutas: Map<string, RutaHandler>,
  registro: RegistroSesiones<SessionManager>,
  credenciales: ProveedorCredencialesRuntime
): void {
  rutas.set('POST /v1/bhe/resumen', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, anio } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.resumen(ejecutor, rut, anio));
  });

  // Ruta aparte y no un flag en /v1/bhe/resumen: el anual de recibidas sale de
  // otro CGI y trae la retención que el mensual de recibidas no muestra.
  rutas.set('POST /v1/bhe/resumen-recibidas', async body => {
    const parseo = zodResumen.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, anio } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.resumenRecibidas(ejecutor, rut, anio));
  });

  rutas.set('POST /v1/bhe/list-emitidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, anio, mes } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
    return ejecutar(() => core.listEmitidas(ejecutor, rut, anio, mes));
  });

  rutas.set('POST /v1/bhe/list-recibidas', async body => {
    const parseo = zodMes.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, anio, mes } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
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
    if (!parseo.success) return badRequest(parseo.error);
    const { rut, codigo_barras, recibida } = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, rut, credencialDe(parseo.data));
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

  // --- Emisión (ronda 11, ESCRITURA) ---------------------------------------
  // confirmar:false (default) PREVISUALIZA con los montos del SII sin emitir;
  // confirmar:true EMITE (irreversible, notifica al receptor). Guardrail de la
  // ronda 11: dry-run + ventana de idempotencia + auditoría.
  rutas.set('POST /v1/bhe/emitir', async body => {
    const parseo = zodEmitir.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const d = parseo.data;
    const params = {
      receptor: { rut: d.receptor_rut, nombre: d.receptor_nombre, direccion: d.receptor_direccion, comuna: d.receptor_comuna },
      lineas: d.lineas,
      retieneReceptor: d.retiene_receptor,
      fecha: d.fecha,
    };
    const ejecutor = ejecutorPara(registro, credenciales, d.rut, credencialDe(d));
    const resp = await ejecutar(() => coreEmision.emitirBhe(ejecutor, d.rut, params, d.confirmar));
    const respBody = resp.body as { ok?: boolean; error?: string; folio?: number | null };
    const total = d.lineas.reduce((a, l) => a + l.valor, 0);
    // Con folio (emisión real) se usa ese. Sin folio (previsualización o fallo)
    // se agrega un hash corto del documento, así dos previsualizaciones
    // distintas al mismo receptor+total no colisionan en la traza.
    const hashDoc = createHash('sha256').update(claveEstable(params)).digest('hex').slice(0, 8);
    const referencia = `bhe:${respBody?.folio ?? `${d.receptor_rut}-${total}-${hashDoc}`}`;
    if (respBody?.ok && d.confirmar) {
      resp.auditoria = { efecto: 'ejecutado', referencia };
    } else if (respBody?.ok) {
      resp.auditoria = { efecto: 'simulado', referencia };
    } else if (d.confirmar && respBody?.error !== ERROR_LIMITE_CONOCIDO) {
      resp.auditoria = { efecto: 'fallido', referencia };
    }
    return resp;
  });

  // confirmar:false PREVISUALIZA la anulación (muestra qué boleta se anularía);
  // confirmar:true ANULA (irreversible). Mismo guardrail que la emisión.
  rutas.set('POST /v1/bhe/anular', async body => {
    const parseo = zodAnular.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const d = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, d.rut, credencialDe(d));
    const resp = await ejecutar(() => coreAnulacion.anularBhe(ejecutor, d.rut, d.folio, d.causa, d.confirmar));
    const respBody = resp.body as { ok?: boolean; error?: string };
    const referencia = `bhe-anulacion:${d.folio}`;
    if (respBody?.ok && d.confirmar) {
      resp.auditoria = { efecto: 'ejecutado', referencia };
    } else if (respBody?.ok) {
      resp.auditoria = { efecto: 'simulado', referencia };
    } else if (d.confirmar && respBody?.error !== ERROR_LIMITE_CONOCIDO) {
      resp.auditoria = { efecto: 'fallido', referencia };
    }
    return resp;
  });

  // Observación del RECEPTOR sobre una boleta recibida. confirmar:false
  // previsualiza; confirmar:true observa (irreversible: el comentario queda).
  rutas.set('POST /v1/bhe/observar', async body => {
    const parseo = zodObservar.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const d = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, d.rut, credencialDe(d));
    const resp = await ejecutar(() => coreObservacion.observarBhe(ejecutor, d.rut, d.anio, d.mes, d.folio, d.causa, d.confirmar, d.emisor_rut));
    const respBody = resp.body as { ok?: boolean; error?: string };
    const referencia = `bhe-observacion:${d.folio}`;
    if (respBody?.ok && d.confirmar) {
      resp.auditoria = { efecto: 'ejecutado', referencia };
    } else if (respBody?.ok) {
      resp.auditoria = { efecto: 'simulado', referencia };
    } else if (d.confirmar && respBody?.error !== ERROR_LIMITE_CONOCIDO) {
      resp.auditoria = { efecto: 'fallido', referencia };
    }
    return resp;
  });

  // Reenvío de una boleta emitida por email (por código de barras).
  // confirmar:false previsualiza (a qué email iría); confirmar:true envía.
  rutas.set('POST /v1/bhe/email', async body => {
    const parseo = zodEmail.safeParse(body);
    if (!parseo.success) return badRequest(parseo.error);
    const d = parseo.data;
    const ejecutor = ejecutorPara(registro, credenciales, d.rut, credencialDe(d));
    const resp = await ejecutar(() => coreEmail.enviarBheEmail(ejecutor, d.rut, d.codigo_barras, d.email, d.confirmar));
    const respBody = resp.body as { ok?: boolean; error?: string };
    const referencia = `bhe-email:${d.codigo_barras}`;
    if (respBody?.ok && d.confirmar) {
      resp.auditoria = { efecto: 'ejecutado', referencia };
    } else if (respBody?.ok) {
      resp.auditoria = { efecto: 'simulado', referencia };
    } else if (d.confirmar && respBody?.error !== ERROR_LIMITE_CONOCIDO) {
      resp.auditoria = { efecto: 'fallido', referencia };
    }
    return resp;
  });
}
